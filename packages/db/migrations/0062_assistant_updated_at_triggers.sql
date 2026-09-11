-- Module tables attach the shared updated_at primitive from
-- docs/specs/db.md §5. Drizzle cannot express triggers; this custom
-- migration is the explicitly approved raw-SQL exception from db.md §7.
-- assistant_chat_state (0057) and assistant_chat_messages (0059) were
-- created without it; assistant_turns is new (SHO-560).
CREATE TRIGGER assistant_chat_state_set_updated_at
BEFORE UPDATE ON assistant_chat_state
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint

CREATE TRIGGER assistant_chat_messages_set_updated_at
BEFORE UPDATE ON assistant_chat_messages
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint

CREATE TRIGGER assistant_turns_set_updated_at
BEFORE UPDATE ON assistant_turns
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
