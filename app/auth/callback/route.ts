import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

import { createClient } from '@/utils/supabase/server';

import { Database } from '@/types_db';

export async function GET(request: NextRequest) {
  const requestUrl = new URL(request.url);
  const code = requestUrl.searchParams.get('code');

  if (code) {
    const supabase = createClient();
    await supabase.auth.exchangeCodeForSession(code);
  }

  // URL to redirect to after sign in process completes
  return NextResponse.redirect(`${requestUrl.origin}/subscription`);
}
