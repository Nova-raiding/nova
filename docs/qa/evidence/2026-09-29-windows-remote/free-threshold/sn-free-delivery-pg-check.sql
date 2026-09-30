\set ON_ERROR_STOP on
BEGIN;
CREATE TEMP TABLE creative_point_reservations(workspace_id text,id text,action_key text,operation_id text,status text,points int,settled_points int);
CREATE TEMP TABLE action_ledger(workspace_id text,action_key text,state text,settlement_status text,provider_request_id text);
CREATE TEMP TABLE model_usage_ledger(workspace_id text,action_id text,provider_request_id text,modality text,settlement_status text,cost_cny numeric(12,6),model text,input_tokens int,output_tokens int,total_tokens int);
CREATE TEMP TABLE creative_point_provider_receipts_v2(workspace_id text,operation_id text,provider text,provider_request_id text,outcome text,verified_at timestamptz,cost jsonb,usage jsonb,receipt_hash text);
CREATE TEMP TABLE creative_point_ledger_events(workspace_id text,event_type text,metadata jsonb,operation_id text);
CREATE TEMP TABLE creative_point_operations(workspace_id text,id text,kind text,status text,idempotency_key text,request jsonb);
CREATE TEMP TABLE creative_point_reversals_v2(workspace_id text,original_reservation_id text);
INSERT INTO creative_point_reservations VALUES('ws_test','r1','a1','op1','settled',3,0);
INSERT INTO action_ledger VALUES('ws_test','a1','settled','settled','p1');
INSERT INTO model_usage_ledger VALUES('ws_test','a1','p1','text','settled',0.09,'model1',1,1,2);
INSERT INTO creative_point_provider_receipts_v2 VALUES('ws_test','op1','model-relay','p1','succeeded',now(),'{}','{}','hash1'),('ws_test','op1','relay','p1','succeeded',now(),'{}','{}','hash1');
INSERT INTO creative_point_ledger_events VALUES('ws_test','settled','{}','settle1');
INSERT INTO creative_point_operations VALUES('ws_test','settle1','settle','completed','commercial.settle:a1','{}');
PREPARE sn_verify(text,text,text,text,text,boolean,boolean) AS

        SELECT count(*)::int AS matched
          FROM creative_point_reservations r
          JOIN action_ledger a ON a.workspace_id=r.workspace_id AND a.action_key=r.action_key
          JOIN model_usage_ledger m ON m.workspace_id=r.workspace_id AND m.action_id=r.action_key AND m.provider_request_id=$4
          JOIN creative_point_provider_receipts_v2 api_receipt ON api_receipt.workspace_id=r.workspace_id
            AND api_receipt.operation_id=r.operation_id AND api_receipt.provider='model-relay' AND api_receipt.provider_request_id=$4
          JOIN creative_point_provider_receipts_v2 worker_receipt ON worker_receipt.workspace_id=r.workspace_id
            AND worker_receipt.operation_id=r.operation_id AND worker_receipt.provider=$5 AND worker_receipt.provider_request_id=$4
          JOIN creative_point_ledger_events ledger ON ledger.workspace_id=r.workspace_id
            AND ledger.event_type='settled' AND ledger.metadata->>'reservation_id'=r.id
          JOIN creative_point_operations settlement ON settlement.workspace_id=ledger.workspace_id AND settlement.id=ledger.operation_id
          CROSS JOIN LATERAL (
            SELECT CASE WHEN jsonb_typeof(api_receipt.cost->'actual')='number'
              THEN (api_receipt.cost->>'actual')::numeric ELSE NULL END AS actual_cost_cny
          ) verified_cost
         WHERE r.workspace_id=$1 AND r.id=$2 AND r.action_key=$3
           AND r.status='settled'
           AND (
             (r.settled_points>0 AND (r.settled_points=r.points OR $6::boolean))
             OR (
               r.settled_points=0 AND r.points>0
               AND m.modality IN ('text','image','image_edit','video')
               AND verified_cost.actual_cost_cny>=0 AND verified_cost.actual_cost_cny<0.1
               AND ledger.metadata->>'point_policy_version'='model.cost_cny_free_lt_0_1.v1'
               AND settlement.request->'metadata'->>'point_policy_version'='model.cost_cny_free_lt_0_1.v1'
             )
           )
           AND a.state='settled' AND a.settlement_status='settled' AND a.provider_request_id=$4
           AND (NOT $7::boolean OR m.modality='text') AND m.settlement_status='settled' AND m.cost_cny IS NOT NULL
           AND api_receipt.outcome='succeeded' AND api_receipt.verified_at IS NOT NULL
           AND worker_receipt.outcome='succeeded' AND worker_receipt.verified_at IS NOT NULL
           AND api_receipt.cost->>'currency'='CNY' AND worker_receipt.cost->>'currency'='CNY'
           AND verified_cost.actual_cost_cny>=0
           AND round(verified_cost.actual_cost_cny,6)=m.cost_cny
           AND worker_receipt.cost->'actual'=api_receipt.cost->'actual'
           AND api_receipt.usage->>'modality'=m.modality AND worker_receipt.usage->>'modality'=m.modality
           AND api_receipt.usage->>'model'=m.model AND worker_receipt.usage->>'model'=m.model
           AND COALESCE(api_receipt.usage->'input_tokens','null'::jsonb)=to_jsonb(m.input_tokens)
           AND COALESCE(api_receipt.usage->'output_tokens','null'::jsonb)=to_jsonb(m.output_tokens)
           AND COALESCE(api_receipt.usage->'total_tokens','null'::jsonb)=to_jsonb(m.total_tokens)
           AND COALESCE(worker_receipt.usage->'input_tokens','null'::jsonb)=COALESCE(api_receipt.usage->'input_tokens','null'::jsonb)
           AND COALESCE(worker_receipt.usage->'output_tokens','null'::jsonb)=COALESCE(api_receipt.usage->'output_tokens','null'::jsonb)
           AND COALESCE(worker_receipt.usage->'total_tokens','null'::jsonb)=COALESCE(api_receipt.usage->'total_tokens','null'::jsonb)
           AND ledger.metadata->>'provider_request_id'=$4
           AND ledger.metadata->>'receipt_hash'=api_receipt.receipt_hash
           AND ledger.metadata->'cost_cny'=api_receipt.cost->'actual'
           AND ledger.metadata->>'modality'=m.modality
           AND settlement.kind='settle' AND settlement.status='completed'
           AND settlement.idempotency_key='commercial.settle:' || r.action_key
           AND settlement.request->>'reservation_id'=r.id
           AND settlement.request->'actual_points'=to_jsonb(r.settled_points)
           AND settlement.request->'metadata'->>'provider_request_id'=$4
           AND settlement.request->'metadata'->>'receipt_hash'=api_receipt.receipt_hash
           AND settlement.request->'metadata'->'cost_cny'=api_receipt.cost->'actual'
           AND settlement.request->'metadata'->>'modality'=m.modality
           AND (SELECT count(*) FROM model_usage_ledger all_usage WHERE all_usage.workspace_id=$1 AND all_usage.provider_request_id=$4)=1
           AND (SELECT count(*) FROM creative_point_ledger_events all_settlements WHERE all_settlements.workspace_id=$1 AND all_settlements.event_type='settled' AND all_settlements.metadata->>'reservation_id'=r.id)=1
           AND NOT EXISTS (SELECT 1 FROM creative_point_reversals_v2 reversal WHERE reversal.workspace_id=$1 AND reversal.original_reservation_id=r.id)
      ;
DO $verify$
DECLARE c record; found int; meta jsonb;
BEGIN
FOR c IN SELECT * FROM (VALUES
 ('free_actual_precision',0.00090156,0,'text','model.cost_cny_free_lt_0_1.v1','model.cost_cny_free_lt_0_1.v1','succeeded',true,1,false),
 ('free_rounds_to_threshold',0.09999999,0,'text','model.cost_cny_free_lt_0_1.v1','model.cost_cny_free_lt_0_1.v1','succeeded',true,1,false),
 ('paid_rounds_to_threshold',0.10000001,3,'text','model.cost_cny_free_lt_0_1.v1','model.cost_cny_free_lt_0_1.v1','succeeded',true,1,false),
 ('free_text',0.09,0,'text','model.cost_cny_free_lt_0_1.v1','model.cost_cny_free_lt_0_1.v1','succeeded',true,1,false),
 ('free_zero_cost',0,0,'text','model.cost_cny_free_lt_0_1.v1','model.cost_cny_free_lt_0_1.v1','succeeded',true,1,false),
 ('free_image',0.099999,0,'image','model.cost_cny_free_lt_0_1.v1','model.cost_cny_free_lt_0_1.v1','succeeded',true,1,false),
 ('free_image_edit',0.09,0,'image_edit','model.cost_cny_free_lt_0_1.v1','model.cost_cny_free_lt_0_1.v1','succeeded',true,1,false),
 ('free_video',0.09,0,'video','model.cost_cny_free_lt_0_1.v1','model.cost_cny_free_lt_0_1.v1','succeeded',true,1,false),
 ('threshold_exact',0.1,0,'text','model.cost_cny_free_lt_0_1.v1','model.cost_cny_free_lt_0_1.v1','succeeded',true,0,false),
 ('negative_cost',-0.01,0,'text','model.cost_cny_free_lt_0_1.v1','model.cost_cny_free_lt_0_1.v1','succeeded',true,0,false),
 ('missing_cost',NULL,0,'text','model.cost_cny_free_lt_0_1.v1','model.cost_cny_free_lt_0_1.v1','succeeded',true,0,false),
 ('ocr_cannot_use_model_policy',0.09,0,'ocr','model.cost_cny_free_lt_0_1.v1','model.cost_cny_free_lt_0_1.v1','succeeded',true,0,true),
 ('bad_ledger_policy',0.09,0,'text','wrong','model.cost_cny_free_lt_0_1.v1','succeeded',true,0,false),
 ('bad_operation_policy',0.09,0,'text','model.cost_cny_free_lt_0_1.v1','wrong','succeeded',true,0,false),
 ('missing_policy',0.09,0,'text',NULL,NULL,'succeeded',true,0,true),
 ('provider_unknown',0.09,0,'text','model.cost_cny_free_lt_0_1.v1','model.cost_cny_free_lt_0_1.v1','unknown',true,0,false),
 ('unverified_worker',0.09,0,'text','model.cost_cny_free_lt_0_1.v1','model.cost_cny_free_lt_0_1.v1','succeeded',false,0,false),
 ('paid_unchanged',0.2,3,'text',NULL,NULL,'succeeded',true,1,false),
 ('partial_paid_disabled',0.2,1,'text',NULL,NULL,'succeeded',true,0,false),
 ('partial_paid_enabled',0.2,1,'text',NULL,NULL,'succeeded',true,1,true)
) AS cases(label,cost,points,modality,ledger_policy,operation_policy,outcome,verified,expected,partial)
LOOP
 UPDATE creative_point_reservations SET settled_points=c.points;
 UPDATE model_usage_ledger SET cost_cny=c.cost,modality=c.modality;
 UPDATE creative_point_provider_receipts_v2 SET outcome=c.outcome,verified_at=CASE WHEN c.verified OR provider='model-relay' THEN now() ELSE NULL END,cost=jsonb_build_object('currency','CNY','actual',c.cost),usage=jsonb_build_object('modality',c.modality,'model','model1','input_tokens',1,'output_tokens',1,'total_tokens',2);
 meta=jsonb_build_object('reservation_id','r1','provider_request_id','p1','receipt_hash','hash1','cost_cny',c.cost,'modality',c.modality,'point_policy_version',c.ledger_policy);
 UPDATE creative_point_ledger_events SET metadata=meta;
 UPDATE creative_point_operations SET request=jsonb_build_object('reservation_id','r1','actual_points',c.points,'metadata',meta || jsonb_build_object('point_policy_version',c.operation_policy));
 EXECUTE format('EXECUTE sn_verify(%L,%L,%L,%L,%L,%L,false)','ws_test','r1','a1','p1','relay',c.partial) INTO found;
 IF found<>c.expected THEN RAISE EXCEPTION 'FAIL % expected % got %',c.label,c.expected,found; END IF;
 RAISE NOTICE 'PASS % matched=%',c.label,found;
END LOOP;
END $verify$;
DO $invalid$
DECLARE raw jsonb; found int;
BEGIN
UPDATE creative_point_reservations SET settled_points=3;
UPDATE model_usage_ledger SET cost_cny=0.09;
FOR raw IN SELECT value FROM jsonb_array_elements('["0.09","NaN","Infinity","not_numeric",null,{},[],true,-0.00000001]'::jsonb)
LOOP
 UPDATE creative_point_provider_receipts_v2 SET cost=jsonb_build_object('currency','CNY','actual',raw);
 UPDATE creative_point_ledger_events SET metadata=jsonb_set(metadata,'{cost_cny}',raw);
 UPDATE creative_point_operations SET request=jsonb_set(request,'{actual_points}','3'::jsonb); 
 UPDATE creative_point_operations SET request=jsonb_set(request,'{metadata,cost_cny}',raw);
 EXECUTE 'EXECUTE sn_verify(''ws_test'',''r1'',''a1'',''p1'',''relay'',false,false)' INTO found;
 IF found<>0 THEN RAISE EXCEPTION 'FAIL invalid numeric %',raw; END IF;
 RAISE NOTICE 'PASS invalid numeric % matched=0',raw;
END LOOP;
END $invalid$;
DO $precision$
DECLARE target text; found int; meta jsonb;
BEGIN
FOR target IN SELECT unnest(ARRAY['baseline','worker','ledger','operation','stored'])
LOOP
 UPDATE creative_point_reservations SET settled_points=0;
 UPDATE model_usage_ledger SET cost_cny=0.00090156;
 UPDATE creative_point_provider_receipts_v2 SET cost=jsonb_build_object('currency','CNY','actual',0.00090156::numeric);
 meta=jsonb_build_object('reservation_id','r1','provider_request_id','p1','receipt_hash','hash1','cost_cny',0.00090156::numeric,'modality','text','point_policy_version','model.cost_cny_free_lt_0_1.v1');
 UPDATE creative_point_ledger_events SET metadata=meta;
 UPDATE creative_point_operations SET request=jsonb_build_object('reservation_id','r1','actual_points',0,'metadata',meta);
 IF target='worker' THEN UPDATE creative_point_provider_receipts_v2 SET cost=jsonb_set(cost,'{actual}','0.00090157'::jsonb) WHERE provider='relay'; END IF;
 IF target='ledger' THEN UPDATE creative_point_ledger_events SET metadata=jsonb_set(metadata,'{cost_cny}','0.00090157'::jsonb); END IF;
 IF target='operation' THEN UPDATE creative_point_operations SET request=jsonb_set(request,'{metadata,cost_cny}','0.00090157'::jsonb); END IF;
 IF target='stored' THEN UPDATE model_usage_ledger SET cost_cny=0.000903; END IF;
 EXECUTE 'EXECUTE sn_verify(''ws_test'',''r1'',''a1'',''p1'',''relay'',false,false)' INTO found;
 IF found<>(CASE WHEN target='baseline' THEN 1 ELSE 0 END) THEN RAISE EXCEPTION 'FAIL precision mismatch % result %',target,found; END IF;
 RAISE NOTICE 'PASS raw precision % matched=%',target,found;
END LOOP;
END $precision$;
ROLLBACK;
