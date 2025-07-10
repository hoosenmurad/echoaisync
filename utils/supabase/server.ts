import { cookies } from 'next/headers';

import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { createClient as createSupabaseClient } from '@supabase/supabase-js';

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

  return createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(
          cookiesToSet: {
            name: string;
            value: string;
            options: CookieOptions;
          }[]
        ) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            );
          } catch (err) {
            console.error('Error setting cookies', err);
          }
        }
      }
    }
  );
}

// ————————————————————————————————————————————————————————————————
// 2) Service-role client (for admin actions, webhooks, background jobs)
// ————————————————————————————————————————————————————————————————
const supabaseService = createSupabaseClient<Database>(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export { supabaseService };

// ————————————————————————————————————————————————————————————————
// 3) Auth & user helpers
// ————————————————————————————————————————————————————————————————
export async function getSession() {
  const supabase = createClient();
  try {
    const {
      data: { session },
      error
    } = await supabase.auth.getSession();
    if (error) throw error;
    return session;
  } catch (error) {
    console.error('getSession error');
    return null;
  }
}

export async function getUserDetails() {
  const supabase = createClient();
  try {
    const { data: user } = await supabase
      .from('users')
      .select('*')
      .single()
      .throwOnError();
    return user;
  } catch (error) {
    console.error('getUserDetails error');
    return null;
  }
}

export async function getSubscription() {
  const supabase = createClient();
  try {
    const { data: subscription } = await supabase
      .from('subscriptions')
      .select('*, prices(*, products(*))')
      .in('status', ['trialing', 'active'])
      .maybeSingle()
      .throwOnError();
    return subscription;
  } catch (error) {
    console.error('getSubscription error');
    return null;
  }
}

export const getActiveProductsWithPrices = async () => {
  const supabase = createClient();
  try {
    const { data } = await supabase
      .from('products')
      .select('*, prices(*)')
      .eq('active', true)
      .eq('prices.active', true)
      .order('metadata->index')
      .order('unit_amount', { foreignTable: 'prices' })
      .throwOnError();
    return data ?? [];
  } catch (error) {
    console.error('getActiveProductsWithPrices error');
    return [];
  }
};

// ————————————————————————————————————————————————————————————————
// 4) Job queries (uses server-side client)
// ————————————————————————————————————————————————————————————————
export async function getJobs() {
  try {
    const supabase = createClient();
    const { data: jobs } = await supabase
      .from('jobs')
      .select('*')
      .order('created_at', { ascending: false })
      .throwOnError();
    return { success: true, data: jobs };
  } catch (error) {
    console.error('getJobs error', error);
    return { success: false, error };
  }
}

export async function getJobsNotDeleted() {
  const supabase = createClient();
  const user = await getUserDetails();
  try {
    const { data: jobs } = await supabase
      .from('jobs')
      .select('*')
      .eq('user_id', user?.id as string)
      .neq('is_deleted', true)
      .order('created_at', { ascending: false })
      .throwOnError();
    return jobs;
  } catch (error) {
    console.error('getJobsNotDeleted error', error);
    return null;
  }
}

export async function getJobsBetweenDates(
  userId: string,
  startDate: string,
  endDate: string
) {
  const supabase = createClient();
  try {
    const { data: jobs } = await supabase
      .from('jobs')
      .select('*')
      .eq('user_id', userId)
      .gte('created_at', startDate)
      .lte('created_at', endDate)
      .throwOnError();
    return jobs;
  } catch (error) {
    console.error('getJobsBetweenDates error', error);
    return null;
  }
}

// ————————————————————————————————————————————————————————————————
// 5) Credit-balance logic
// ————————————————————————————————————————————————————————————————
export async function getCreditBalance() {
  const subscription = await getSubscription();

  if (subscription) {
    // metadata is Json | null, so we need to check and cast
    const rawMetadata = subscription.prices?.products?.metadata;
    const metadata: Metadata | null =
      rawMetadata &&
      typeof rawMetadata === 'object' &&
      rawMetadata !== null &&
      'credits' in rawMetadata
        ? (rawMetadata as unknown as Metadata)
        : null;
    const subscriptionCredits = Number(metadata?.credits ?? 0);
    const jobs = await getJobsBetweenDates(
      subscription.user_id as string,
      subscription.current_period_start as string,
      subscription.current_period_end as string
    );
    const creditsSpent = jobs
      ? jobs.reduce((sum, job) => sum + (job.credits || 0), 0)
      : 0;
    return {
      remaining: subscriptionCredits - creditsSpent,
      outOf: subscriptionCredits
    };
  }

  // fallback: free-tier
  const defaultCredits = 7_500;
  const { success, data: allJobs } = await getJobs();
  const creditsSpent = success
    ? (allJobs as any[]).reduce((sum, job) => sum + (job.credits || 0), 0)
    : 0;
  return {
    remaining: defaultCredits - creditsSpent,
    outOf: defaultCredits
  };
}

// ————————————————————————————————————————————————————————————————
// 6) Job mutation helpers (use server-side or service role where appropriate)
// ————————————————————————————————————————————————————————————————
export async function insertJob() {
  const supabase = createClient();
  const user = await getUserDetails();
  const jobPayload = {
    user_id: user?.id as string,
    status: 'pending' as JobStatus
  };
  try {
    const { data } = await supabase
      .from('jobs')
      .insert([jobPayload])
      .select()
      .throwOnError();
    return data ?? [];
  } catch (error) {
    console.error('insertJob error', error);
    return [];
  }
}

export async function updateJob(jobId: string, updatedFields: any) {
  try {
    const supabase = createClient();
    const { data } = await supabase
      .from('jobs')
      .update(updatedFields)
      .eq('id', jobId)
      .select()
      .throwOnError();
    return data ?? [];
  } catch (error) {
    console.error('updateJob error', error);
    return [];
  }
}

export async function updateJobByOriginalVideoUrl(
  originalVideoUrl: string,
  updatedFields: any
) {
  const supabase = createClient();
  try {
    const { data } = await supabase
      .from('jobs')
      .update(updatedFields)
      .eq('original_video_url', originalVideoUrl)
      .select()
      .throwOnError();
    return data ?? [];
  } catch (error) {
    console.error('updateJobByOriginalVideoUrl error', error);
    return [];
  }
}

export async function updateJobByTranscriptionId(
  transcriptionId: string,
  updatedFields: any
) {
  try {
    const { data } = await supabaseService
      .from('jobs')
      .update(updatedFields)
      .eq('transcription_id', transcriptionId)
      .select()
      .throwOnError();
    return data ?? [];
  } catch (error) {
    console.error('updateJobByTranscriptionId error', error);
    return [];
  }
}
