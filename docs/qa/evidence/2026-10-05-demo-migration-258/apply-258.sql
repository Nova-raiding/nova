-- Reviewed demo-only 257 -> 258 migration. No credentials.
-- Run only against the owner-confirmed demo target after backup/restore verification.
-- Requires the exact current 1..257 prefix; reruns fail rather than alter history.
BEGIN;
SET LOCAL lock_timeout='15s';
SELECT pg_advisory_xact_lock(731942851);
CREATE TEMP TABLE expected_chain(version integer,name text,checksum text) ON COMMIT DROP;
INSERT INTO expected_chain VALUES
(1,'initial','5e5a59c7aead849cb86c2fcb4963a2c0ce382b087ccc3d20c4d75f3ea2fdbda5'),
(2,'force_rls','4c9cbaa96832e7ae02619999e11f24dfd9ae91ead093d651870f146a3490857c'),
(3,'outbox_delivery_state','6a7fe0027f065c436c6973c0992514a31ee405f2c7d55df85b7ef740e773dcfc'),
(4,'business_entities','d79ad50a607f1912c8be81de79988fda0236998a225dad161f36a23b5aea6bf0'),
(5,'generation_jobs','46dfccd5425b363fffdc57d43c981a8b88ed2c9f75c51bb7daccf8bae0b1281a'),
(6,'brand_assets','c1c43512123c1c8c69530fcf4d234bd78bb6564c80f07c44bc07ef2e55f30ae0'),
(7,'multi_account_products','da7e4d17cf03efded820bcbca287ebb6a4db8f46ee9ae1d489f7468c74cedc5e'),
(8,'rule_center','61ea7882961d7946d05004d51964f5892d2d72b4a98a9c88de7cb007eb570788'),
(9,'feedback','05233ad65262fa323477176bfc1acd045634a1a2df109d26435f74fa3f31b6c6'),
(10,'workspace_rls','c142f80577a02bd265c3a1cd62f1f8196aa46a795611eb7149e1a8e2ac9f0377'),
(11,'sync_jobs','fe4b99c113f5d77c55ae128adb75a0595f755fdbd5cfc6cffff80e382e06d0fa'),
(12,'nullable_remote_product_id','84099a6a078039b263f84679d61a82f71b5b7fa037223f0557e2894c431460bb'),
(13,'billing','bfd079af68fb44753e83185be2a71f9dfe46b403436c3de6ab6b74d1097d2fcb'),
(14,'store_aliases','a99f84e40ffb757935907435b3e8a70fec97c6da85d807908b524adb64e92244'),
(15,'platform_authorization_health','298c374eaa284c78b2254f78f3b6f52b13c4825503dedaa68248e3e7bd2f7fd0'),
(16,'image_generation_jobs','22d9dd671a62cc9c207387138977ff29aa7644c55308d3e6c4ac0bafd8c8bebf'),
(17,'commercial_settings','bb1fcef295a4c9b604253dbae836fee9430251f3830daebbd46e283bff67c824'),
(18,'commercial_price_cny','12adec04ca80541da9ebe025331a7777dc86494b658cb0c7d48cb8d39863d5b2'),
(19,'usage_ledger','e2f2ca011aa64af4e01506661e04f416a3dd5b460d9c29df67e752fd130ab3f2'),
(20,'operation_audit','32caf5956aed17a79465214827d26ab7b0f05761853952fece5d9dc0964c55e6'),
(21,'subscriptions','ee2edc2ad2740d40c301e0f67b5b9d6a8c2416ab01e7044746353bce76df5eaa'),
(22,'workspace_members','5680793e9c5f69c007869b206e39e2616acf20a18ea179af63207b3d73f905b8'),
(23,'commercial_extensions','b15da32c79997fc31689973f0ba67a27df1be3e19d1ccbfb708a79eb63ef65e6'),
(24,'subscription_order_commercial_snapshot','1f01f67320527e339c4261a997a87086e99d544a2bd3ad4a1136a3c70e21f2e2'),
(25,'growth_events','d5dcbb14512f52c3d844ce94128ec4db08a8d99e97af943168435484fca6b3ee'),
(26,'operation_alerts','7647c54f40540551059dcc297458d228f447cda97dd8910da7eeb6dcf7fddad2'),
(27,'data_deletion_requests','77ea29378924c02eea23b7ba7679af1dfa94544e0b6e7f6aa7beecacf83326c6'),
(28,'data_deletion_approvals','97b965d3d08b60bdba1c5547887767d737b9ff595a265b446a8692c8f19bec1f'),
(29,'rule_effectivity','1d05d827ec9640fda2e6d1881104316378056b1296800af8b80c55814f97b975'),
(30,'data_deletion_execution_proof','ba23c305eeff367e79a322fa04908e8a62c7ef6d838c1dab53edcadc80f47782'),
(31,'social_commerce_platforms','f2051c25477e887f017e4a82298a8e55e68e38317ad7cd0804bf124fa4579814'),
(32,'automation_policies','aa5f7926c2041d2b6f702b096eb2fbfa9edf96f77777fd1913a1295c3c6d5995'),
(33,'workspace_id_text','31a6253b322787e5299b74fccf8be91c97c34d4bdaad2ebccc191f523a30df5c'),
(34,'model_usage_ledger','ba7a72a83d2d53e59e1ff19589524ca67786da9fabe5cc582fa1f7d3d47af82e'),
(35,'action_ledger','3e2e840cf14d1f6b520870ca347f8807bd3b4ee3cd4887977906fc13578a012a'),
(36,'subscription_entitlements','eef35fcbf663c6812e5a09016ce5db6fc2b250f1acb5c5d2c896aac51662bb4c'),
(37,'entitlement_consumptions','a0d4ef85d61c94b82e59b9e18dc8118264cd7171c68e6efc4b56adc4164c1286'),
(38,'action_ledger_kinds','52651506d2bd171aa3275b1a87c078c347cda15f1648c712e739937803699607'),
(39,'multi_brand_batch','c1c65acccdaeb4af7ccf26d8f509250921b543ed8f994babc573e7cd6a0f15d4'),
(40,'force_commercial_settings_rls','2e37b9ab27ddf4b0035a239c420ec09509e64a95d62c8ce9aa774d0b75918372'),
(41,'subscription_payment_checkout','9e76ed7a8d03d7b47854623c4980ec5fcc102ceeb5e653854a690665bdf69403'),
(42,'model_markup_policy','f1586cfb5a3f3b1f8f8d2cdde00272743dd95988b2d3f968f6018b2c9fd1051e'),
(43,'route_b_expand','c25465e488f0a78ed480828870551d7715ebad9e372f7b2627c9708107f4ab65'),
(44,'platform_workspace_directory','edd71aaa9bba68098bfb60e067684df7e15d4a80edd14038790ffb35268b80bd'),
(45,'platform_identity_lifecycle','c0ab696abb2f118f0efb8f0aeb253916f5ed823104f1ec7e1a0a0ddf676ec57a'),
(46,'model_usage_settlement','96cc4448684c3e67991da2687fae62e471532f95f87b32660bfcc7917cfb5162'),
(47,'route_b_task_projection','fc329a81a7d98e067d4ceaac216e454a45c822668742837ed46d6c2c5fe3e7e9'),
(48,'action_ledger_scope_links','64ae6782b65f053349812629ffb485ca52431a24166f06b30f4be7d7cd440fa5'),
(49,'legacy_snapshot_backfill','89768cd2d66c7efbde1fda9181eb08e8ba77902725a398254d125eb8998be208'),
(50,'payment_callback_nonces','f56a1b7fe191425e4960f770d4346c733bf46ea08561f07b5a712d76423a5c21'),
(51,'active_workspace_catalog','ab77dfc02047d7df2ee44b637fd9e15f2844b3bd4f113ebb0ed3ea10d101b5ba'),
(52,'workspace_context_snapshots','cd33369051939e19cec93e5ed87d56ef2e45fe2fa9771f713b13aba30e4f3a88'),
(53,'terminal_generation_outbox_cleanup','b450eb1ab3b63c532e6b4de092e76b3de8d0a0de6a2e9c8aa7d5747a0f1345ce'),
(54,'model_daily_cost_budget','08d6617cc0960a9f5d749a0c7a17ec743d57566374b080b90d1325bf568289d9'),
(55,'support_crm','ba922ce1c328835e05ee26b5742acee0a6bb88b00398cb53c292ed22e8425bf2'),
(56,'incidents','310848a7e19ecf7e930fa54eca08a4828de702a8a0eb8cb5b8324b1c24a3c84d'),
(57,'feature_flags','adec1152f7c25cb9bf1d2674a77b69394816db456714c59022c67a2447e23f4f'),
(58,'finance_search_indexes','bbae6ba0283a176da8ecf5b6c93828d4c45970f85c3ef1aff977560c69d89db3'),
(59,'ops_audit_center','b2936b6ffe4e3fb00330c06c20e904ef06b375805b51cd7b7e618ce99a13846e'),
(60,'merchant_collection_pagination_indexes','00d87e18c7706d0ac472d703c74badf012cda789eab71afcc633c09342c6f4bc'),
(61,'platform_control_plane_acl','684535af31489b27a465e5f05aaabab570f2d709c848b14cb782ae24956fa463'),
(62,'remove_duplicate_pagination_index','992fbac076205a1c126c2eeb6cd923cac67e9bf3b01755c6ebf4f1ae9e2dee03'),
(63,'product_listing_brand_canonical_integrity','edf57d769088c865e40f3fcfbc3a2efcc88c62982d13bf454e6067573ca09642'),
(64,'workspace_identity_bootstrap','af325586fc4a289ea0053cd10f8028ed5b481f020bc8ddd0375eb535adf9794d'),
(65,'asset_parse_leases','8a7faa2ec4023109e351521d86044f066117845a055cd83c3122c8974c6c11a0'),
(66,'platform_media_spec_registry','5c728a727badda9be92f2c01cdc17b4684582f01daa5988c55f6d060f96b764e'),
(67,'platform_mapping_preflight_approvals','65dc3c0ac0da95df5b660c928a72553a7418c19d75a362275df8fc691625d282'),
(68,'campaign_lifecycle_runtime_grants','fab905af77b4db328819c2aa1209f0cbb47419101f82f41511d86b320b1787fc'),
(69,'platform_account_scope_integrity','493bcb2f9d4ec42d539c77d34faf1502b0bb94b36c0146d94aba410cf1e224f7'),
(70,'product_asset_bindings','c01c2c9cc897c4923c9cc5974795d8869d6eee7d9f60a34cb8d9b7935bebebd3'),
(71,'runtime_integrity','aca71d1af1ce4f25d54653256f999dcf12c5c284ea8ad3e811f72bb425d92282'),
(72,'product_asset_binding_integrity','5e49613893811d7f11f7429107c0c0bace5ae40114ed33179019eb5eb486c650'),
(73,'ops_data_contracts','045d399061f37283ee51cbe1942ace462955840e29b1a9f89dbef772dcb85b56'),
(74,'model_usage_context_links','5543bf28272a5b682df852443449dd73ab05b94f03ac0522f451924bf3a408ec'),
(75,'model_usage_action_lookup_index','1094eab7269237ec7dcbb72bf7190c1c9e7c25bcb01b46f123adbb819f3392c0'),
(76,'canonical_product_backfill_index','a8c72e2b3152a75100fa57791928ffcc3229c0a675bc4986816bf91dc1d25f65'),
(77,'canonical_publish_scope_integrity','4f2367681696a9c715daf0426a03301e04279a388469878cbe6da3d9b31c9201'),
(78,'asset_snapshot_binding_backfill','184699ee07cf8edc48663db6a2a3ac8e46b3803c8104a44690a93614150883df'),
(79,'knowledge_hydration_snapshots','e5059cc0ca9dbd0c7ed15ebac966f7d2f636db87004e12b84c75dc6e49f5f288'),
(80,'storage_quota','d2c3b231d7cc27b26070b484b71efd08367bcc11bc0b06ae922883b64b88e221'),
(81,'reconciliation_status','8fdd0e32ca02dcd9de7efb522af5f061580026e8a3a2b6341bcb7047714978a3'),
(82,'knowledge_hydration_revision_repair','1898260a7e7507d79c0db3c4fbc31e7c0bf749d47c918c7b8c6ec519cd9b73c6'),
(83,'billing_actor_attribution','606fb334f5800fc4b44c68157460a9e45e7c17c4df25417c848fbb2a82bbec3e'),
(84,'asset_scan_receipts','9b1295d7b37edd65e0c077f37cb9277fe82493a5da88ffa0d5d2d50c90128de0'),
(85,'asset_scan_attempts','ad187b29fc040f2916fec82bd36d2abd7738b0727ec8a5b365c9dab0a0817282'),
(86,'trusted_clean_asset_backfill','eb75ed6773b624a209bd8298f5d03f4451cab4e27bdacbc63cd205f211a37eaa'),
(87,'asset_promotion_cleanup_tasks','6ec0f79d555f1875c244aa5cdb80c0c2fc56e53ab25e4e9774e5edee8e88142c'),
(88,'image_generation_continuation_leases','bfcbb98ee4eea67c257ddb89dc39c44e9def7263ba8f0dadf3ebdc55254797a6'),
(89,'merchant_intent_snapshots','2f9399455118c9ac47aa9ef385c54753678ed4a1d8c1135958fd0b38e1a6b07c'),
(90,'isolate_ops_workspace_directory','7b4c7697d46dc88bde57a6b309e5603cd904715c3c05485f30ea847796680646'),
(91,'bind_platform_scope_to_ops_role','9524b05a688df06db7b30563e4e5bd6a6ff92a8b96cb93444a5e5c1c8dd1eeea'),
(92,'image_generation_executions','b9c10f14f6665bab75df7d2e217408ed93fde8a00a732686f0aba7b1651cad6b'),
(93,'runtime_delete_privilege_hardening','85b3673213e552ed211000b0880a772b1c3c6105e2eac36b33f78b649b0e1a92'),
(94,'image_generation_reconciliation_cursor_index','762cedb39cb836bde8172a47221c5ca2fcc7fef1a992ac4e5fcd0eb6ac529295'),
(95,'runtime_append_only_privileges','b0599337b837375a10c8405107c40c19e01c6b0d0b57ff98f9362938c3528643'),
(96,'reconciliation_evidence','713cac37c51c397e8d2fc0f0d91dc374a8c5b0974795298ace6f54d3cf3d1f2a'),
(97,'reconciliation_evidence_unknown_errors','9af7babe89b1583b49a6434de61f42c4be489cceb2b59c28ae18448c2b02368e'),
(98,'unified_link_audit','6fe546a1331b3e749370fdc54c77cf204f9f1643b6edead133945c163cb8b934'),
(99,'canonical_legacy_brand_integrity','efee2e5177e8a8e0477a84d07c187b5cc452d1c4883dfe71f6547339d8263102'),
(100,'operation_alert_notifications','eac982d6be0148f62af509efc4676570b95537154df76431e64f457f470714c4'),
(101,'canonical_backfill_runs','f95d887ac0596eb329b98065b85c4cd732e5a8784b5a45ad09e2c6a5683cbb4e'),
(102,'canonical_backfill_conflicts','7526eabf646f1ddef0c3b975f211ddf85da52613cc30b85c0f314575b0d590cd'),
(103,'operation_alert_notification_acl','9a889acd6ae3d3c82761a53b949c7204a87efe90c487b3e9e25b0a4725d26970'),
(104,'interactive_confirmation_tickets','a22026ce961fee78d75f527be096c693ca04040487db931c946c018e16068853'),
(105,'durable_authorization_grants','b66867c46c7acfab07b8221f5b6d8945961130b2005e0ffc18560792906d2f54'),
(106,'canonical_legacy_brand_integrity_guard','15144ccbd768e8a65284cecd1cc4fa9cb52e096a4956b528bc30cb030fb25efc'),
(107,'canonical_backfill_conflict_verification_evidence','4dd0344c7eb435218a305a6224bee6287b95ba13143d5c5367f3d2dd9153db35'),
(108,'model_usage_settled_cost_invariant','32520c2e9ca7345ddf25a09a44cc5d6507c7bb7b1951edaee58cbaabb026526d'),
(109,'asset_scan_redrive','912b169c9cda6627e0e0290c9f9ad87f18ade88a727f095c309118ffa58488b0'),
(110,'unified_model_run_cost_budget','e6d803d1b588b7d29c5ca27ff1fe00cb8909917bc3bb667ee392b37c085fe6e9'),
(111,'harden_model_run_budget_linkage','2b5e57bd12d293aff42df95a57563f99abdd7cfbe6195f5e08a66fa8288f7251'),
(112,'support_sla_snapshot','5a5e554ea12efe999312599952b80a7a6f93a2becb44622149fef501edf3a4d6'),
(113,'support_sla_events','7b11c9f4c7a5d5fab9de1bbf8ffffae329c65d64baa51f21940f485108eaed6a'),
(114,'support_sla_reporting','4010dcabbf374775f4c73d4c8ba62fa4b343f2c0dece33ffe8c55ac5037203c2'),
(115,'support_sla_correction_decisions','74b5e9711ce52d65613f5942f5f2381c6dc148e123526e13f597405ea53a9d1c'),
(116,'support_sla_correction_approvals','dfbbd6add680553b3e909bcdfaee219ce0d34c71c82341987f9d8879f3ca75d8'),
(117,'image_generation_provider_operation_reservation','39bd8c29f6779ea54018e85df1a3b6ece53a13a077556cef1373d18539062f14'),
(118,'enforce_model_usage_budget_run_linkage','a008fedb21873730f447947d91a8da56bc8016878ea950119d5f22dc779ef196'),
(119,'image_generation_execution_dispatch_fence','87c63d0572aaceb1df19f110e15133f5f57805a4a3b914d834b56804ea38d5b0'),
(120,'authorization_execution_reservations','dbc168335d6c17f790b65befe46ad065aa371309f6d69ffba35ee07c61a651f9'),
(121,'authorization_execution_reservations_acl','68ca5e36a8758823b604396c29bd63f5bf7627f4febb41a4dedf606e8fa67611'),
(122,'campaign_item_legacy_canonical_integrity','458b1ed2808989dd495fd07e38638dafa38f03550f097653e45d7eb75411b677'),
(123,'commercial_order_snapshots','0ebcf50fc617d5aa27635f97536d37a1fda8b2fd333c98ec13432b30a2966e22'),
(124,'block_platform_role_in_workspace_members','b539a84131f879e7f23736bd6b4e526ec23a3c294ec9e8ee8922f00d59a8f35d'),
(125,'authorization_events_append_only','4f2f4115f1c79093e55af1cdf6d4a5a2ada8b3314fdba56ae2225116343b7084'),
(126,'context_snapshot_canonical_scope_integrity','161ee314712e6927d93e551346f9dba0bca3cbbeda7de26038e1335b7ef2c282'),
(127,'validate_platform_role_boundary','b95034779c51db1139776840df381bffd93ca792faa7957fd7f35deeed47f6b1'),
(128,'product_listing_identity_uniqueness','16865da39eb1de104bab643593088c5d436c9975cdfab8b1bd531ab8ffdca330'),
(129,'campaign_item_listing_scope_integrity','8a8d440be5d34d99e8fa7f71e6dc7fe6b477735244052aeadc9f34e252a6ba88'),
(130,'canonical_legacy_identity_uniqueness','49190c2c002d340e0f85788bc031d84348113e73e51a08ef11312a46380a3be6'),
(131,'task_campaign_item_scope_integrity','8210613f050f6fe7d6a3bd555ac9187d6a52b6bdbdd597d648f46efcecfead9a'),
(132,'rule_audit_append_only_acl','fa7c11ac8dd60045c38a6e14965e3ac63a17e75108d2e2cc28918b4337320072'),
(133,'parallel_migration_merge_barrier','3a29393d67d3c907b4f741eceee37f91a5b0da508416a91682a476b350e89b24'),
(134,'authorization_events_truncate_guard','2f51080f08f2dc246ee347b490fdda7b7bd5aa0a9c272988a9f45b23accc7559'),
(135,'authorization_event_scope_integrity','ad52a1c433e9d10d13bd637ac135da0dcc229347541d863903f10b00e3c3da9b'),
(136,'workspace_operation_audit_truncate_guard','61732cb70dc0500c517ca5e5291903a1f70f4174fd8b737e45f14661d45563d2'),
(137,'task_canonical_listing_identity','68d30ba589809dbf7741fcd12d12b5db62f0204b87c610ede8830c6c71404650'),
(138,'interactive_confirmation_ticket_nonce_digest','d06153ffbfcff17f78a8e3783de90d68565b2ff7d25d065beb9c49c38207f040'),
(139,'interactive_confirmation_ticket_reservations','3c8a04bc4cd0e2c443568ff8b16fb0d9c2b3925fc464891f09a13a645a5ca502'),
(140,'interactive_confirmation_ticket_fencing','26b232490f94ec129acb9d51475f5171427aa7f25fb17af9fe31f521bfc84c9c'),
(141,'interactive_confirmation_ticket_acl_guard','add05be9c559269aeb4e97064348a91ab4a84f9334c550b6e75137b07a8172ce'),
(142,'authorization_execution_decision_correlation','ef04b44bf6f21c08de478e01dffd84a576f78b9f192a04e68f154fcb2e2f1ee4'),
(143,'require_ops_platform_scope_for_summary','1f26ecdfa7b6aab07b11327a6645f5075c90a0c032374f60db283d3f52bb37cf'),
(144,'creative_point_ledger','fc051959e11ff4814a3bdea0757930be37fb3f516687ceb73d558b86ad30c3f2'),
(145,'harden_ops_workspace_summary_security','2906ce5b3cc5f9cef5c6f49ce93549aebdefbd872b45bbd0c14a572ffcff5d02'),
(146,'commercial_catalog_v2','ffee31f866a0140f6c2d74799822709d466b7fbe336d8bf0a72410c1001379ac'),
(147,'platform_authorization_audit','a8f9ff9b0a5741dffa6410bda500cb3919946ce98430c186dec3cf55667bf086'),
(148,'harden_creative_point_reservations','751ea5a58ee0d6b1f32273680757bfcad919bc8cc621a82cd738f3224b0cd650'),
(149,'object_storage_orphan_leases','eee4a8e16f37b35f6bb7617cfeda16e65dfa1ad2bd983b6b92de9da6ba8c9739'),
(150,'repair_legacy_creative_point_allocations','2c8dd78dbaf632055615ef1f032453381041379ca9feca6a6d65c1102668a993'),
(151,'repair_legacy_creative_point_allocation_constraint','9c1364e194f56391a722c3a04fb945a5c20b3cd918ce9825665a3cac171207bb'),
(152,'authorization_grant_scope_integrity','682b6c3e14558d07844aae3bffc0361c240a23addccc1dcfe09eefabf8bad427'),
(153,'commercial_contract_facts','22e5d23a42ccda81f90e77e020ffa395b2f70f8bc4a3cf9ea9a541252c75b9f1'),
(154,'service_fulfillment_and_onboarding_schedule','bca300d3c3fee943d64013ff4e9d7e446f16655eaaedc54f08a23813aabd4f16'),
(155,'workspace_data_export_requests','cfffbf7fad25f6888e7faae8ae521159e5ba9f009d42dc8053290f0e29845e10'),
(156,'commercial_outbox_insert_acl','f541a0e253c060907abb08409bf667f3be593251983fe939fa2a41d9161201fd'),
(157,'service_fulfillment_audit_evidence','e7bcd4cba1d325b44ab96cb7cadaf340f090def632d7c541dc31a04c093ea5e0'),
(158,'creative_point_reversal_allocation_guard','7756eed03701beb9ace475e352743b665e29f6a87f6e1fcab2db10446d299b10'),
(159,'commercial_point_adjustment_approvals','0be258688789bb5c1f60a6dad7ad844b0bc61dfb295defb6bd5cf3717c79d5fb'),
(160,'commercial_point_adjustment_approval_acl','061c22e8eae3eda8581ce6e2939e072356149a76fe655aa3f1024f563db6750e'),
(161,'image_generation_execution_state_repair','b8facb519e2c15dc38cd6eac8fc1054797792ff32ca30d43ec2b2be7471bed61'),
(162,'image_generation_execution_state_constraint_name_repair','4ec8a6fc3b5efe3ba05be999770548da92de50eff3a7eb29aa6f0db53b8b9359'),
(163,'authorization_workspace_scope_contract','2fde0aa8fdd8dbf8e1340f0b8df87a3e98ffbeeffd6da1420249486cb753df39'),
(164,'onboarding_grant_schedule_activation','feeac8794150778eae9d78f33b65b6c2564297b16a7e90d67a26c399603fa124'),
(165,'object_storage_orphan_runtime_acl','40f29b1b5e479075d9abba2aecd459daece23e81ced6049833f617091589db7d'),
(166,'commercial_catalog_executable_v2','fce9e57e1bb883f9175ccedd4f95e351803079e5ca911fbb7e49299415e8e910'),
(167,'private_trial_conversion_closure','0fb60b15370e98df5145d23da54eef444a453a4df97289b00f5355ab2df37007'),
(168,'onboarding_grant_dispatch','c79b7e6772d14891d631c5ca226f35ab8d7f5e40e19ea2398dd19b434dbb6afe'),
(169,'onboarding_grant_expiration','ffdbeeb680d91858a62c84d8efa4dcf2da7f5edec9452b3f9c0cc1304f8493cd'),
(170,'commercial_refund_events','d4cda4afc194153ca11479696ddcc438efaa79aaf72500b24ddaddb72cafd7ea'),
(171,'commercial_refund_runtime_acl','77fb600e2484fcfcbc5fab978ae19cd7ff45a7bd4cdcbbbc42955df66871c035'),
(172,'private_trial_invites','a9f75905c6ed73237c08fb03bbfb2d9a0da217210329febc86b027ca8c5cbbae'),
(173,'private_trial_invite_events','aa1870d68f0aad078f45567a30fc8fd4a5b40645a374a6030100598781b3c55f'),
(174,'private_trial_entitlement_activation','e2b159d58e14814318a94c7eb3e67f903f642832556251f28fe5945b346ec2c9'),
(175,'repair_legacy_task_snapshot_scope','f47e404f99c1cd496d408d7da1bffe6bf18cc8dac751b5b62bb4e54b1a1d38ba'),
(176,'private_trial_entitlement_benefits','5564d33cf474efe58cda1065d060d8a12086d9ccfdbbb8e8e7e2495c4bea1dd3'),
(177,'reclassify_manual_rule_sources','7f4190e57e69515a250c092c1f55361e06084ba27e2469ed8d8bfb599b19e465'),
(178,'reclassify_manual_rule_sources_again','b42b129441f3edce9e080d9d375c8de00fb6f258ab334ca17e963981451d140b'),
(179,'campaign_item_task_scope_integrity','9187413374fee96b8f227c4161b296ef176c078c281fdcee9c9ab56ec5f6df9e'),
(180,'remove_creative_point_allocation_granularity_constraint','8fe28e8b0d1c8bcc2773691c2e8636d29ff0681f4582eea193f9e263ed696a92'),
(181,'commercial_checkout_resource','3ee9ad1244f4d9b6c4d3493d8d8031dc34bc75ecb7eba0ad516f14891cb5dae5'),
(182,'password_auth','1423a2a0cd4c8f65b81c8bd1465296b992f6f628cda644343a550db772ae3b25'),
(183,'knowledge_persistence','4aec7e63cd77b823cf7a1471c395b9e407dc2a31b571a1d25beea3daf995f9b2'),
(184,'harden_knowledge_audit_facts','520dcc912465c64f443fbebfa1476b46bb8944ada1d03a7ab623305223c78b67'),
(185,'harden_runtime_role_acl','0ea5dcce51612e0ba89b5b65f3a638d432a0682bddd184cc4cdcf6b403bd7649'),
(186,'harden_runtime_auth_acl','be2c276b53cea57e4b24b4db88b041543aba56e6a0a80bb1ccbf5f7612058ca1'),
(187,'enterprise_tenant_root','912db5a71bbae4894313ad25a14cb22b533fb92a5956a045103053cb8abd0b60'),
(188,'enterprise_workspace_bootstrap','6ec4f2013cf3dbe1d8e465c7a6c061c20a6baed04c0c164065ae3d5617079bc6'),
(189,'enterprise_display_projection','867f2da1e8973ffb9dabfedc7ecbec93373635d6456d80fc5a2633021045f515'),
(190,'registration_rejected','c3c372bdfdfd141174f708d5666f1913e0eb184f0cee1d58a0a6c56648ca3f13'),
(191,'rule_pack_category','fbf1027fb43b027356d3d31f6812fb1208ecf8e71f5000a0af81750b8050cb9f'),
(192,'allow_cent_test_orders','b60aee207c7409e5485d2c58fa561f47741d43a77fa6d306563f3fd207400c15'),
(193,'enterprise_name_sync_acl','aa4866b89f1537a65a1bedfedd0b0609c53a98b8d93d81682bd9b3ca06f650a3'),
(194,'lock_workspace_enterprise_binding','6e0b98b68a4e04bd8e9a8a3b4167e3f1ce3ed22bffba3dfdff2547261d5692ab'),
(195,'commercial_catalog_ops_write','911d742eb81c73a96c2a0136aa34cf04ea22088bb56b36b1ee4d7d23028c4692'),
(196,'customer_delivery_workspace','b73ad22a33864ff576912b8f462a9afeea5036b882df8e7765282e0af84af3d8'),
(197,'customer_delivery_checklist_items','3bff6b2dbf05b2a8a3eafbff50f68aa075e39432b7fcf95ec8b6803cee973ce1'),
(198,'canonical_catalog_knowledge','85d8cebcdb25b20d6d926f191aec6cdb9039fe86d5fa39ab43a05c1201c39720'),
(199,'customer_delivery_retention_fk','1870ae1fc2d261ba7a7d36662232aa568229e8b1143c0e20ab6b81692728538b'),
(200,'customer_delivery_control_plane_acl','dc886590be488d3bc52ba64c31f7c27211b8e1928bdb6c7a5d2e908dff181c34'),
(201,'customer_delivery_required_evidence','8efef5f14af4c67354d81d6dc6b5831b3ed232d0c6242fd5e187f580bbe2fa5f'),
(202,'customer_delivery_evidence_transition','db52a8188d90eebfdcdc0afdb56afbddb55a1492d1a559f16571e2ac76903469'),
(203,'workspace_identity_binding_member_fk','290d1abbacc454da4012622b99de68cd9e8460a25e82ee9185330278aa73e01b'),
(204,'customer_delivery_atomic_evidence','42e9754b71d309caf7e09174c0d660b246aceea1d167ba22439a83a3a09cb8a7'),
(205,'customer_delivery_evidence_identity_invalidation','3099c797247296b71259366e191b36318c7265b7b08a55b5378c0dedd827da4e'),
(206,'customer_delivery_evidence_invalidation_lock_order','98306aa48960984028a84b8a4a906083a3af89f1f5a8e5988001229aa7bf0afb'),
(207,'customer_delivery_evidence_receipt_identity','17e51a7ddd521fea9ea80976597a996d2183789d22ca77a20d014fe5ef8a73ab'),
(208,'alert_webhook_receipts','4da1557e814296ba87eaa492c90c13031e928afa417dc0b5843e5350e71bf9e2'),
(209,'isolate_alert_webhook_receiver_role','3db2c267ea64ff0287d26fd881fcd75871e4d106e18f1171deaf50c36780adeb'),
(210,'mcp_oauth_identity','38f11a93273c6d37b0de36ab85b919627822f8151cf7ea26f7bc9afbbe79d0e0'),
(211,'mcp_oauth_workspace_rls','7d66597a476c5e709011fed52862f6f5183cba73f49b066a7dbecc3f99281917'),
(212,'customer_delivery_training_without_evidence','062521c5ceff7825c6fd9b7ff9136572972902822e52970eb99c5ba21fc43fe0'),
(213,'customer_delivery_manual_verification','8053be06b78b9a2054d8de4d7690b86e2f52c58662fae33da3dbcaafee7e6359'),
(214,'customer_delivery_archival','601a3d8a76b23eb9db9f3c76e99833d3fccd20c91d23227134bbf669bc0e9f8b'),
(215,'customer_delivery_account_binding','f15f31e0c123521b5096d5c65f172a5b94aa6638f8db392dc90a489a8bf96e04'),
(216,'workspace_content_setup','3c546071e99d91bf8d7e86828a1d8ed80c251a584535789690d864e9fc9b8937'),
(217,'model_usage_embedding_modality','252c281c21b7a93b58b2129604297a5006265004e96aad1c12e5ab4b9b6c0831'),
(218,'manual_publish_evidence','bf0b3dd8c6f1fb612047a274683db17ac23ca50f9ea0a47ea53f66747c8193c1'),
(219,'public_platform_rules','0a13802714155d2f5398f42981f75a12cfdc548e08964e81c6464156bf2d8f13'),
(220,'commercial_refund_cumulative_bound','ce233b01a01127dc2b7f98bdd0a5e8d66e2aa3fa7bda03c0806235ec4a63b1f4'),
(221,'commercial_refund_amount_bound','3370306911b7682a39148824bc1f96edc19777f6b838e6238cb70d0e9c1ac54e'),
(222,'ops_audit_center_page_indexes','d7846a2aa18517f13f8ca1e11ea44b75487246b44829bfde990eda74a5411799'),
(223,'merchant_catalog_projection','b9ccc8c97474b8d5d044508933ffa714dde03a19fc3ad2642828666f63120fa6'),
(224,'public_platform_rule_audit_truncate_guard','ba96ddb47359627ab961de3eeb96ef0466b4bb52a030f0a3e6057fc6d8f9aff2'),
(225,'append_only_ledger_truncate_guards','da75ef10acf67b45784e2417a8266fa429a9aa73a8432e7e32e7aea5407b1bfc'),
(226,'evidence_and_snapshot_truncate_guards','ababf19a8cef2a6398160d148c68258b1356adac9dcee109b228c78f0df7854c'),
(227,'platform_media_spec_audit_append_only','4a500eea6116985bc23db3efacc7f663b7d2ecb8456cd7825be157ad424cf7e9'),
(228,'audit_ledger_errno_contract','fce1b6125c53e80455fcd606106b3f8a51bcc10d4dedc2e04c335c0996ddfdcf'),
(229,'evidence_and_snapshot_append_only_guards','1650539db4bfc402622eee7a41b3dc75309f6d7019cf11ada5bcc8ed9f4c09a9'),
(230,'revoke_tenant_dml_on_shared_platform_rules','36e754c16b9b646e046912a7ba6fcc6e7b69faffcaba75cd9a2b180dfdcc5f07'),
(231,'storage_quota_per_object_reservation_keys','40c30359f39677b1f72826e83da326b7fdc32c03278d6fd3500628f3124d4825'),
(232,'storage_quota_unnameable_reservation_keys','a5bb2087a9df72ebbb61f460e818083c39283944068c00cddd13ff9de5e2850f'),
(233,'support_sla_correction_approval_approver','4f2313b1df199dd999c7440a3092c6812d33b0d1d438e23dbcd3304de77d3ba0'),
(234,'repair_customer_delivery_control_plane_acl','ac5fa50ead6fecf02e2ef3367f730eacc4eb2bab033f4aac1370927026d7e7b3'),
(235,'repair_authorization_reservation_acl','08699e683f6242a8cad3af7ba71fcbb8645d6723496532678e0eabbe965b9f42'),
(236,'repair_ops_read_acl','3d9224e4584ffb3d2322d22d0db78fc766421eda2ecd5a9f20411da1a49447eb'),
(237,'repair_control_plane_identity_acl','1d98926dd52f508ce818670930127fa5a7f3406376aea5316c1454fd3d5cb02f'),
(238,'repair_durable_authorization_acl','a509c154def26d747d4f82f53e4cc7672d6b59bee44809ebcb087c4fb8abcccb'),
(239,'repair_mcp_oauth_ops_acl','7733c016ac11368dda5b04f43f562632489ccab01882d785c8e67108e1c83ced'),
(240,'revoke_mcp_oauth_app_acl','90d1884b9a49fc0433648cb9b55d28193605ca10c462aa0409d38d1b643a7916'),
(241,'repair_ops_directory_finance_read_acl','f60dbd3a353b9ef493370ef14b2fe156403e3dff7d34ffa8074c12b5c1d46ee9'),
(242,'repair_creative_point_allocation_reservation_index','60ff06d2023b9d271537d2f2c18141a79b3e4874a4449ba06a1315df5f79d3a0'),
(243,'local_plugin_connection_requests','46d4d1e6f5c39da1349ea2ba1db3860a899d6698eaca1e2e30441ce3c3038932'),
(244,'local_plugin_install_instances','09f533578a1495f88815e13359f47b0c953100371e2b32471101c8901a4f6bf9'),
(245,'local_plugin_authorized_timestamp','5ff1f7066b2c4d63313681f59f81aaf602744e339e421de43c52d01d7ab9cb84'),
(246,'demo_evaluation_entitlement','ecd9e5539ad461455cb4e7c8f500dcb110edaeea9af20c17549af2d337935b67'),
(247,'ocr_cost_rate_v3','0e166f97cd73990e003ceb656f6b0c053f40dba1c63b7c62be010a76001c127e'),
(248,'ocr_free_threshold_rate_v4','1c7becc72036119f1985ab3ce2823104b6e9b108240e9bd0be8c8a1bf51018ad'),
(249,'creative_point_action_key_unique','48ea5a4dae9ecd40ab89b915dc25b7302e5f0667dd8c286b271f60063cead687'),
(250,'knowledge_generation_claim_fence','b55c9b39a5969807d20e9a1b27bed8225245ee34398d668775c57d759b32c9b8'),
(251,'creative_point_action_claims','c8cc3688b4340ea54ad261a6adab82f4176352efcfc67968bde4a169c53e9004'),
(252,'charged_text_dispatch_attempts','cb753137f7e21f0cbdb602fd4c666cfdb35bc1e5e4c274b7ea708cba04546027'),
(253,'charged_text_no_delivery_resolution','4ca2cbcf1ed75413a27afa98cf359efd320f7806c4e5145152899a1bb63a984a'),
(254,'merchant_entitlement_snapshot_cursor','22c2b5a45158c5725054ea58950cce2a5ff05f17dda488904a5a5b27b923119d'),
(255,'scoped_brand_settings','3ca08679671e6d427308f19594a987d157efa33639d461cd84339d703ab0c279'),
(256,'asset_lifecycle','2c1bcf1fb344dbc2f3823d0ffc85b3561b1e3163e367f1bb45f2941c613ee619'),
(257,'asset_snapshot_lifecycle_guard','2fdb248a39f67eb061522d7dc2597ddde847b7e8731f05db8a7c4e3518c5c908'),
(258,'knowledge_generation_claim_usage_evidence','d2b2af238582d087c50bfd11f75f5e98c39adbd2890128d363e62970f1cc6ab7');
DO $$ BEGIN IF EXISTS (SELECT version,name,checksum FROM schema_migrations EXCEPT SELECT version,name,checksum FROM expected_chain WHERE version<=257) OR EXISTS (SELECT version,name,checksum FROM expected_chain WHERE version<=257 EXCEPT SELECT version,name,checksum FROM schema_migrations) THEN RAISE EXCEPTION '257 prefix mismatch'; END IF; END $$;
-- Close an outcome-unknown knowledge claim only after the durable model usage
-- ledger proves that the exact provider attempt was settled.  Keep migration
-- 250's seven-argument function for already-deployed callers; this overload
-- is the forward-compatible path used by the current repository.
CREATE OR REPLACE FUNCTION settle_knowledge_generation_claim(
  p_workspace_id text, p_claim_id text, p_provider_attempt_id text,
  p_provider_attempt_key text, p_request_body_sha256 text, p_request_nonce text,
  p_to_state text, p_provider_request_id text
) RETURNS TABLE(claim_state text, claimed_at timestamptz, updated_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE c public.knowledge_generation_claims%ROWTYPE; v_action_id text;
BEGIN
  IF current_setting('app.workspace_id', true) IS DISTINCT FROM p_workspace_id THEN
    RAISE EXCEPTION 'knowledge workspace scope mismatch' USING ERRCODE='42501';
  END IF;
  SELECT * INTO c FROM public.knowledge_generation_claims
    WHERE workspace_id=p_workspace_id AND claim_id=p_claim_id FOR UPDATE;
  IF NOT FOUND OR c.provider_attempt_id<>p_provider_attempt_id
    OR c.provider_attempt_key<>p_provider_attempt_key
    OR c.request_body_sha256<>p_request_body_sha256
    OR c.request_nonce<>p_request_nonce THEN
    RETURN;
  END IF;
  IF c.state=p_to_state THEN
    RETURN QUERY SELECT c.state,c.created_at,c.updated_at;
    RETURN;
  END IF;
  IF c.state='outcome_unknown' AND p_to_state='completed' THEN
    SELECT NULLIF(btrim(e.payload->>'action_id'),'') INTO v_action_id
      FROM public.outbox_events e
      WHERE e.workspace_id=p_workspace_id AND e.id=c.event_id
        AND e.aggregate_id=c.aggregate_id AND e.event_type='generation.requested';
    -- A creative-point provider receipt is not sufficient to release the
    -- knowledge mutation fence.  Require the model usage ledger's settled,
    -- cost-bearing row and the exact physical provider-attempt metadata.
    IF v_action_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM public.model_usage_ledger m
      WHERE m.workspace_id=p_workspace_id
        AND m.action_id=v_action_id
        AND m.modality='text'
        AND m.settlement_status='settled'
        AND m.cost_cny IS NOT NULL
        -- Current text workers persist the physical idempotency key as
        -- provider_attempt_id, while the claim ledger also stores a
        -- deterministic provider_attempt_id UUID.  Accept either exact
        -- identity from the same claim; both are bound by the claim CAS
        -- fields above and cannot be supplied by an unrelated attempt.
        AND (m.metadata->>'provider_attempt_id'=c.provider_attempt_id
          OR m.metadata->>'provider_attempt_id'=c.provider_attempt_key)
        AND (p_provider_request_id IS NULL OR m.provider_request_id=p_provider_request_id)
    ) THEN
      RETURN;
    END IF;
  END IF;
  IF NOT ((c.state='claimed' AND p_to_state IN ('provider_started','rejected')) OR
    (c.state='provider_started' AND p_to_state IN ('outcome_unknown','completed','rejected')) OR
    (c.state='outcome_unknown' AND p_to_state='completed')) THEN
    RETURN;
  END IF;
  UPDATE public.knowledge_generation_claims SET state=p_to_state,updated_at=now(),
    terminal_at=CASE WHEN p_to_state IN ('completed','rejected') THEN now() ELSE NULL END
    WHERE workspace_id=p_workspace_id AND claim_id=p_claim_id
    RETURNING state,knowledge_generation_claims.created_at,knowledge_generation_claims.updated_at
      INTO claim_state,claimed_at,updated_at;
  RETURN NEXT;
END $$;

REVOKE ALL ON FUNCTION settle_knowledge_generation_claim(text,text,text,text,text,text,text,text) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='merchant_app') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION settle_knowledge_generation_claim(text,text,text,text,text,text,text,text) TO merchant_app';
  END IF;
END $$;

INSERT INTO schema_migrations(version,name,checksum) SELECT * FROM expected_chain WHERE version=258;
DO $$ BEGIN IF EXISTS (SELECT version,name,checksum FROM schema_migrations EXCEPT SELECT version,name,checksum FROM expected_chain) OR EXISTS (SELECT version,name,checksum FROM expected_chain EXCEPT SELECT version,name,checksum FROM schema_migrations) THEN RAISE EXCEPTION '258 chain mismatch'; END IF; END $$;
COMMIT;
