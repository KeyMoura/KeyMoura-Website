import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { isUserAdmitted } from "@/lib/accountAdmission";

const INVALID_LOGIN = "Incorrect email or password.";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const body = (await request.json().catch(() => null)) as
    | { email?: unknown; password?: unknown }
    | null;
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body?.password === "string" ? body.password : "";

  if (!email.includes("@") || !password) {
    return NextResponse.json({ error: INVALID_LOGIN }, { status: 400 });
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
  if (!url || !key) {
    return NextResponse.json({ error: "Authentication is unavailable." }, { status: 503 });
  }

  // Stage cookie mutations and return them only after the account is admitted.
  const success = NextResponse.json({ signedIn: true });
  const supabase = createServerClient(url, key, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (cookies) =>
        cookies.forEach((cookie) =>
          success.cookies.set(cookie.name, cookie.value, cookie.options)
        ),
    },
  });

  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error || !data.user) {
    return NextResponse.json({ error: INVALID_LOGIN }, { status: 401 });
  }

  if (!(await isUserAdmitted(data.user.id))) {
    await supabase.auth.signOut().catch(() => undefined);
    return NextResponse.json({ error: INVALID_LOGIN }, { status: 401 });
  }

  return success;
}
