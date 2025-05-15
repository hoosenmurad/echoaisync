import { cookies } from 'next/headers';

import { createServerClient } from '@supabase/ssr';
import { createClient as createAnonClient } from '@supabase/supabase-js';

import { JobStatus } from '@/types/db';
import { Database } from '@/types_db';

interface Metadata {
  credits: string;
}

// ————————————————————————————————————————————————————————————————
// 1) Server-side client (uses Next.js cookies for auth)
// ————————————————————————————————————————————————————————————————
export function createClient() {
  const cookieStore = cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            );
          } catch {
            // Handle errors if necessary
          }
        },
      },
    }
  );
}

// ————————————————————————————————————————————————————————————————
// 2) Service-role client (for admin actions, webhooks, background jobs)
// ————————————————————————————————————————————————————————————————
const supabaseService = createAnonClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// ————————————————————————————————————————————————————————————————
// 3) Auth & user helpers
// ————————————————————————————————————————————————————————————————
export async function getSession() {
  const supabase = await createClient();
  try {
    const { data: { session } } = await supabase.auth.getSession();
    return session;
  } catch (error) {
    console.error('getSession error', error);
    return null;
  }
}

export async function getUserDetails() {
  const supabase = await createClient()
  try {
    const { data: user } = await supabase
      .from('users')
      .select('*')
      .single()
    return user
  } catch (error) {
    console.error('getUserDetails error', error)
    return null
  }
}

export async function getSubscription() {
  const supabase = await createClient()
  try {
    const { data: subscription } = await supabase
      .from('subscriptions')
      .select('*, prices(*, products(*))')
      .in('status', ['trialing', 'active'])
      .maybeSingle()
      .throwOnError()
    return subscription
  } catch (error) {
    console.error('getSubscription error', error)
    return null
  }
}

export const getActiveProductsWithPrices = async () => {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from('products')
    .select('*, prices(*)')
    .eq('active', true)
    .eq('prices.active', true)
    .order('metadata->index')
    .order('unit_amount', { foreignTable: 'prices' })

  if (error) console.error('getActiveProductsWithPrices error', error)
  return data ?? []
}

// ————————————————————————————————————————————————————————————————
// 4) Job queries (uses server-side client)
// ————————————————————————————————————————————————————————————————
export async function getJobs() {
  try {
    const supabase = await createClient()
    const { data: jobs } = await supabase
      .from('jobs')
      .select('*')
      .order('created_at', { ascending: false })
    return { success: true, data: jobs }
  } catch (error) {
    console.error('getJobs error', error)
    return { success: false, error }
  }
}

export async function getJobsNotDeleted() {
  const supabase = await createClient()
  const user = await getUserDetails()
  try {
    const { data: jobs } = await supabase
      .from('jobs')
      .select('*')
      .eq('user_id', user?.id as string)
      .neq('is_deleted', true)
      .order('created_at', { ascending: false })
    return jobs
  } catch (error) {
    console.error('getJobsNotDeleted error', error)
    return null
  }
}

export async function getJobsBetweenDates(
  userId: string,
  startDate: string,
  endDate: string
) {
  const supabase = await createClient()
  try {
    const { data: jobs } = await supabase
      .from('jobs')
      .select('*')
      .eq('user_id', userId)
      .gte('created_at', startDate)
      .lte('created_at', endDate)
    return jobs
  } catch (error) {
    console.error('getJobsBetweenDates error', error)
    return null
  }
}

// ————————————————————————————————————————————————————————————————
// 5) Credit-balance logic
// ————————————————————————————————————————————————————————————————
export async function getCreditBalance() {
  const subscription = await getSubscription()

  if (subscription) {
    // @ts-ignore
    const metadata: Metadata = subscription.prices?.products?.metadata
    const subscriptionCredits = Number(metadata?.credits)
    const jobs = await getJobsBetweenDates(
      subscription.user_id as string,
      subscription.current_period_start as string,
      subscription.current_period_end as string
    )
    const creditsSpent = jobs
      ? jobs.reduce((sum, job) => sum + (job.credits || 0), 0)
      : 0
    return {
      remaining: subscriptionCredits - creditsSpent,
      outOf: subscriptionCredits,
    }
  }

  // fallback: free-tier
  const defaultCredits = 7_500
  const { success, data: allJobs } = await getJobs()
  const creditsSpent = success
    ? (allJobs as any[]).reduce((sum, job) => sum + (job.credits || 0), 0)
    : 0
  return {
    remaining: defaultCredits - creditsSpent,
    outOf: defaultCredits,
  }
}

// ————————————————————————————————————————————————————————————————
// 6) Job mutation helpers (use server-side or service role where appropriate)
// ————————————————————————————————————————————————————————————————
export async function insertJob() {
  const supabase = await createClient()
  const user = await getUserDetails()
  const jobPayload = { user_id: user?.id as string, status: 'pending' as JobStatus }
  const { data, error } = await supabase
    .from('jobs')
    .insert([jobPayload])
    .select()
  if (error) console.error('insertJob error', error)
  return data ?? []
}

export async function updateJob(jobId: string, updatedFields: any) {
  try {
    const supabase = await createClient()
    const { data } = await supabase
      .from('jobs')
      .update(updatedFields)
      .eq('id', jobId)
      .select()
    return data ?? []
  } catch (error) {
    console.error('updateJob error', error)
    return []
  }
}

export async function updateJobByOriginalVideoUrl(
  originalVideoUrl: string,
  updatedFields: any
) {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from('jobs')
    .update(updatedFields)
    .eq('original_video_url', originalVideoUrl)
    .select()
  if (error) console.error('updateJobByOriginalVideoUrl error', error)
  return data ?? []
}

export async function updateJobByTranscriptionId(
  transcriptionId: string,
  updatedFields: any
) {
  try {
    // use service-role for webhook callbacks if you prefer
    const { data } = await supabaseService
      .from('jobs')
      .update(updatedFields)
      .eq('transcription_id', transcriptionId)
      .select()
    return data ?? []
  } catch (error) {
    console.error('updateJobByTranscriptionId error', error)
    return []
  }
}
