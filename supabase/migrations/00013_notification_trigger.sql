
-- ── Notification trigger ─────────────────────────────────────────────────────
-- Automatically creates in-app notifications when ticket activities are logged.

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
    IF v_assignee IS NOT NULL AND v_assignee <> NEW.actor_id THEN
      INSERT INTO public.notifications (user_id, ticket_id, type, title, body)
      VALUES (
        v_assignee, v_ticket_id, 'assignment',
        'Ticket assigned to you',
        'Ticket ' || v_ticket_number || ' has been assigned to you.'
      );
    END IF;

  -- Status change → notify the requester
  ELSIF NEW.activity_type = 'status_change' THEN
    IF v_requester <> NEW.actor_id THEN
      INSERT INTO public.notifications (user_id, ticket_id, type, title, body)
      VALUES (
        v_requester, v_ticket_id, 'status_change',
        'Ticket status updated',
        'Ticket ' || v_ticket_number || ' status changed to ' || COALESCE(NEW.new_value, 'unknown') || '.'
      );
    END IF;

  -- Comment → notify requester and assignee (excluding the actor)
  ELSIF NEW.activity_type = 'comment' THEN
    IF v_requester <> NEW.actor_id THEN
      INSERT INTO public.notifications (user_id, ticket_id, type, title, body)
      VALUES (
        v_requester, v_ticket_id, 'comment',
        'New comment on your ticket',
        LEFT(COALESCE(NEW.content, ''), 500)
      );
    END IF;

    IF v_assignee IS NOT NULL AND v_assignee <> NEW.actor_id AND v_assignee <> v_requester THEN
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

CREATE TRIGGER on_ticket_activity_notify
  AFTER INSERT ON public.ticket_activities
  FOR EACH ROW EXECUTE FUNCTION on_ticket_activity_notify();
