import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    // Verify caller is sysadmin via their JWT
    const authHeader = req.headers.get("Authorization") ?? "";
    const callerToken = authHeader.replace("Bearer ", "");

    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const { data: { user: caller }, error: authErr } = await supabaseAdmin.auth.getUser(callerToken);
    if (authErr || !caller) return json({ error: "Unauthorized" }, 401);

    const { data: callerProfile } = await supabaseAdmin
      .from("profiles")
      .select("role")
      .eq("id", caller.id)
      .maybeSingle();

    if (!callerProfile || callerProfile.role !== "sysadmin") {
      return json({ error: "Forbidden: sysadmin only" }, 403);
    }

    const body = await req.json();
    const { action, user_id, username, password, full_name, role, office, contact } = body;

    // ── UPDATE username / password ──────────────────────────────────
    if (action === "update") {
      if (!user_id) return json({ error: "user_id required" }, 400);

      // Update password if provided
      if (password) {
        if (password.length < 6) return json({ error: "Password must be at least 6 characters" }, 400);
        const { error } = await supabaseAdmin.auth.admin.updateUserById(user_id, { password });
        if (error) return json({ error: error.message }, 400);
      }

      // Build profile patch
      const patch: Record<string, unknown> = {};
      if (username !== undefined) {
        if (!/^[a-zA-Z0-9_]+$/.test(username)) {
          return json({ error: "Username may only contain letters, digits, and underscores" }, 400);
        }
        // Check uniqueness (exclude self)
        const { data: conflict } = await supabaseAdmin
          .from("profiles")
          .select("id")
          .eq("username", username)
          .neq("id", user_id)
          .maybeSingle();
        if (conflict) return json({ error: "Username already taken" }, 409);
        patch.username = username;
        // Keep the synthetic email in sync
        const { error: emailErr } = await supabaseAdmin.auth.admin.updateUserById(user_id, {
          email: `${username}@miaoda.com`,
        });
        if (emailErr) return json({ error: emailErr.message }, 400);
      }
      if (full_name !== undefined) patch.full_name = full_name;
      if (role !== undefined) patch.role = role;
      if (office !== undefined) patch.office = office;
      if (contact !== undefined) patch.contact = contact;

      if (Object.keys(patch).length > 0) {
        const { error } = await supabaseAdmin.from("profiles").update(patch).eq("id", user_id);
        if (error) return json({ error: error.message }, 400);
      }

      return json({ success: true });
    }

    // ── DELETE user ─────────────────────────────────────────────────
    if (action === "delete") {
      if (!user_id) return json({ error: "user_id required" }, 400);
      // Prevent self-deletion
      if (user_id === caller.id) return json({ error: "Cannot delete your own account" }, 400);

      const { error } = await supabaseAdmin.auth.admin.deleteUser(user_id);
      if (error) return json({ error: error.message }, 400);
      return json({ success: true });
    }

    return json({ error: "Unknown action. Use: update | delete" }, 400);
  } catch (err) {
    return json({ error: String(err) }, 500);
  }
});
