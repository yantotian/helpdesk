import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const ALLOWED_ROLES = new Set(["requester", "technician", "it_admin", "sysadmin"]);

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
    const { action, user_id, username: rawUsername, password, full_name, role, office, contact } = body;
    const username = typeof rawUsername === 'string' ? rawUsername.toLowerCase() : rawUsername;

    // ── UPDATE username / password / profile ─────────────────────
    if (action === "update") {
      if (!user_id) return json({ error: "user_id required" }, 400);

      // Only allow known roles
      if (role !== undefined && (typeof role !== "string" || !ALLOWED_ROLES.has(role))) {
        return json({ error: "Invalid role. Use: requester | technician | it_admin | sysadmin" }, 400);
      }

      // Fetch the target profile for guards + audit logging
      const { data: target, error: targetErr } = await supabaseAdmin
        .from("profiles")
        .select("id, role, is_active")
        .eq("id", user_id)
        .maybeSingle();
      if (targetErr || !target) return json({ error: "User not found" }, 404);

      // Guards around role changes
      if (role !== undefined && role !== target.role) {
        if (user_id === caller.id) {
          return json({ error: "You cannot change your own role" }, 400);
        }
        if (target.role === "sysadmin") {
          const { count } = await supabaseAdmin
            .from("profiles")
            .select("id", { count: "exact", head: true })
            .eq("role", "sysadmin")
            .eq("is_active", true);
          if ((count ?? 0) < 2) {
            return json({ error: "Cannot demote the last active System Admin" }, 400);
          }
        }
      }

      // Update password if provided
      if (password) {
        // Keep minimum in sync with PASSWORD_MIN_LENGTH in src/lib/utils.ts
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
        patch.email = `${username}@ciodesk.com`;
        // Keep the synthetic email in sync
        const { error: emailErr } = await supabaseAdmin.auth.admin.updateUserById(user_id, {
          email: `${username}@ciodesk.com`,
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

      // Audit role changes
      if (role !== undefined && role !== target.role) {
        await supabaseAdmin.from("audit_log").insert({
          actor_id: caller.id,
          table_name: "profiles",
          record_id: user_id,
          action: "role_update",
          old_data: { role: target.role },
          new_data: { role },
        });
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