import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const ALLOWED_ROLES = new Set(["requester", "technician", "it_admin", "sysadmin"]);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { username: rawUsername, password, full_name, role, office, contact } = await req.json();

    if (!rawUsername || !password) {
      return new Response(
        JSON.stringify({ error: "username and password are required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const username = rawUsername.toLowerCase();

    // Validate password minimum length (keep in sync with PASSWORD_MIN_LENGTH in src/lib/utils.ts)
    if (password.length < 6) {
      return new Response(
        JSON.stringify({ error: "Password must be at least 6 characters" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Validate username (letters, digits, underscore only)
    if (!/^[a-zA-Z0-9_]+$/.test(username)) {
      return new Response(
        JSON.stringify({ error: "Username may only contain letters, digits, and underscores" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // Resolve caller. Public self-registration can NEVER escalate privileges:
    // only an authenticated System Admin may create privileged accounts.
    let callerIsSysadmin = false;
    const authHeader = req.headers.get("Authorization") ?? "";
    const callerToken = authHeader.replace("Bearer ", "");
    if (callerToken) {
      const { data: { user: caller }, error: authErr } = await supabaseAdmin.auth.getUser(callerToken);
      if (!authErr && caller) {
        const { data: callerProfile } = await supabaseAdmin
          .from("profiles")
          .select("role")
          .eq("id", caller.id)
          .maybeSingle();
        callerIsSysadmin = callerProfile?.role === "sysadmin";
      }
    }

    const requestedRole = ALLOWED_ROLES.has(role) ? role : "requester";
    const assignedRole = callerIsSysadmin ? requestedRole : "requester";
    const email = `${username}@ciodesk.com`;

    // Check username availability
    const { data: existing } = await supabaseAdmin
      .from("profiles")
      .select("id")
      .eq("username", username)
      .single();

    if (existing) {
      return new Response(
        JSON.stringify({ error: "Username already taken" }),
        { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const { data, error } = await supabaseAdmin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { username, full_name: full_name || username, role: assignedRole, office, contact },
    });

    if (error) {
      return new Response(
        JSON.stringify({ error: error.message }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Update profile with office/contact if provided
    if (office || contact) {
      await supabaseAdmin
        .from("profiles")
        .update({ office, contact })
        .eq("id", data.user.id);
    }

    return new Response(
      JSON.stringify({ user: data.user, role: assignedRole }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: String(err) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});