-- Remove the optional LLM resolver.
--
-- It was never implemented — tier 3 was always skipped — and it is not wanted.
-- This drops the columns that existed only to support it and closes the gap it
-- left in the tier numbering.
--
-- Tiers become:  0 alias · 1 exact · 2 fuzzy · 3 you
--
-- Renumbering rather than leaving a hole at 3 keeps the scale contiguous, so
-- nothing has to carry a comment explaining an absent tier. Existing rows are
-- migrated, so no history is lost.

UPDATE job_item SET resolved_tier = 3 WHERE resolved_tier = 4;
UPDATE game     SET resolved_tier = 3 WHERE resolved_tier = 4;

-- A learned alias could in principle have been attributed to the resolver.
-- Nothing ever produced one, but the constraint is being removed either way.
UPDATE learned_alias SET source = 'user' WHERE source = 'llm';

ALTER TABLE job DROP COLUMN resolver_used;
ALTER TABLE match_candidate DROP COLUMN llm_note;

DELETE FROM settings WHERE key = 'resolver_provider';
