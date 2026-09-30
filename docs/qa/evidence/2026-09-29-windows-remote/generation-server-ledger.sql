BEGIN READ ONLY;
SELECT row_to_json(x) FROM (
SELECT m.workspace_id,m.action_id,m.id AS usage_id,m.model,m.modality,m.provider_request_id,m.input_tokens,m.output_tokens,m.total_tokens,m.cost_cny,m.settlement_status,m.observed_at,r.id AS reservation_id,r.points,r.settled_points,r.status AS reservation_status,r.rate_card_version,r.finalized_at,p.provider,p.outcome,p.verified_at,p.receipt_hash,p.usage,p.cost
FROM model_usage_ledger m LEFT JOIN creative_point_reservations r ON r.workspace_id=m.workspace_id AND r.action_key=m.action_id LEFT JOIN creative_point_provider_receipts_v2 p ON p.workspace_id=r.workspace_id AND p.operation_id=r.operation_id AND p.provider_request_id=m.provider_request_id
WHERE m.workspace_id='ws_guirenniaoniao' AND m.action_id='content-draft:e8a5441f0202b40a4fbd942970429cb9016e93c9016838f3994a435cbd6a3440'
) x;
ROLLBACK;
