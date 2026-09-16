-- ── Allow system-generated activities (nullable actor_id) ─────────────────────
-- System events (auto-assign, SLA breach) have no human actor. The timeline
-- displays them as "System".

ALTER TABLE public.ticket_activities ALTER COLUMN actor_id DROP NOT NULL;

-- Update the notification trigger so NULL-actor (System) events still notify
-- the right recipients instead of evaluating NULL in the <> comparisons.
CREATE OR REPLACE FUNCTION on_ticket_activity_notify()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_requester uuid;
  v_assignee  uuid;
  v_ticket_number text;
  v_ticket_id uuid := NEW.ticket_id;
BEGIN
  SELECT requester_id, assigned_to, ticket_number
  INTO v_requester, v_assignee, v_ticket_number
  FROM public.tickets WHERE id = v_ticket_id;

  IF v_requester IS NULL THEN RETURN NEW; END IF;

  -- Assignment → notify the assignee
  IF NEW.activity_type = 'assignment' THEN
    IF v_assignee IS NOT NULL AND (NEW.actor_id IS NULL OR NEW.actor_id <> v_assignee) THEN
      INSERT INTO public.notifications (user_id, ticket_id, type, title, body)
      VALUES (
        v_assignee, v_ticket_id, 'assignment',
        'Ticket assigned to you',
        'Ticket ' || v_ticket_number || ' has been assigned to you.'
      );
    END IF;

  -- Status change → notify the requester
  ELSIF NEW.activity_type = 'status_change' THEN
    IF NEW.actor_id IS NULL OR NEW.actor_id <> v_requester THEN
      INSERT INTO public.notifications (user_id, ticket_id, type, title, body)
      VALUES (
        v_requester, v_ticket_id, 'status_change',
        'Ticket status updated',
        'Ticket ' || v_ticket_number || ' status changed to ' || COALESCE(NEW.new_value, 'unknown') || '.'
      );
    END IF;

  -- Comment → notify requester and assignee (excluding the actor)
  ELSIF NEW.activity_type = 'comment' THEN
    IF NEW.actor_id IS NULL OR NEW.actor_id <> v_requester THEN
      INSERT INTO public.notifications (user_id, ticket_id, type, title, body)
      VALUES (
        v_requester, v_ticket_id, 'comment',
        'New comment on your ticket',
        LEFT(COALESCE(NEW.content, ''), 500)
      );
    END IF;

    IF v_assignee IS NOT NULL AND (NEW.actor_id IS NULL OR NEW.actor_id <> v_assignee) AND v_assignee <> v_requester THEN
      INSERT INTO public.notifications (user_id, ticket_id, type, title, body)
      VALUES (
        v_assignee, v_ticket_id, 'comment',
        'New comment on assigned ticket',
        LEFT(COALESCE(NEW.content, ''), 500)
      );
    END IF;
  END IF;

  RETURN NEW;
END;
$$;