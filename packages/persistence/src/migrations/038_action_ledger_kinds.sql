ALTER TABLE action_ledger DROP CONSTRAINT IF EXISTS action_ledger_action_kind_check;
ALTER TABLE action_ledger ADD CONSTRAINT action_ledger_action_kind_check CHECK (action_kind IN ('model_text','model_image','model_ocr','model_video','seo','brief','publish','catalog_sync','platform_connect','image_edit','creative_preview','other'));
ALTER TABLE action_ledger DROP CONSTRAINT IF EXISTS action_ledger_settlement_check;
ALTER TABLE action_ledger ADD CONSTRAINT action_ledger_settlement_check CHECK (settlement IN ('included_quota','entitlement','wallet','wallet_overage'));
