ALTER TABLE office_proposals ADD COLUMN build_state TEXT;
ALTER TABLE office_proposals ADD COLUMN build_kind TEXT;
ALTER TABLE office_proposals ADD COLUMN build_branch TEXT;
ALTER TABLE office_proposals ADD COLUMN build_note TEXT;
ALTER TABLE office_proposals ADD COLUMN build_updated_at TEXT;
CREATE INDEX office_proposals_build_queue ON office_proposals(build_state,id);
