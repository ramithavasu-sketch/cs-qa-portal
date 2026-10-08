-- New role: QA Evaluator (QA analysts). Kept in its own migration because a new
-- enum value can only be used after the transaction that adds it has committed.
alter type public.app_role add value if not exists 'evaluator';
