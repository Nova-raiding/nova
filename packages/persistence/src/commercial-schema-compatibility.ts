import { loadMigrations,verifyAppliedMigrations,type AppliedMigration,type Migration } from './migration.js'
import type { SqlClient } from './repository.js'

export class CommercialSchemaCompatibilityError extends Error {
  readonly code='COMMERCIAL_SCHEMA_INCOMPLETE'
  constructor(message:string){super(message);this.name='CommercialSchemaCompatibilityError'}
}
let bundled:Promise<Migration[]>|undefined
async function verifyMissingCommercialObjectPrefix(client:SqlClient,objectIdentity:string,introducedVersion:number):Promise<false>{
  const history=(await client.query<AppliedMigration>('SELECT version,name,checksum FROM public.schema_migrations ORDER BY version ASC')).rows
  const migrations=await(bundled??=loadMigrations())
  const tail=history.at(-1)?.version
  if(!tail||tail>=introducedVersion||migrations.length<introducedVersion||history.length!==tail||history.some((row,index)=>row.version!==index+1))throw new CommercialSchemaCompatibilityError(`required commercial object ${objectIdentity} is absent from an incomplete or current schema`)
  if(history.some(row=>typeof row.checksum!=='string'||!/^[0-9a-f]{64}$/.test(row.checksum)))throw new CommercialSchemaCompatibilityError('commercial compatibility requires a verified checksum for every migration')
  verifyAppliedMigrations(history,migrations)
  return false
}
const projectionFunctions={
  'public.merchant_entitlement_snapshots_v2(integer)':223,
  'public.merchant_entitlement_snapshots_v3(integer,timestamptz,text)':254,
} as const
export type CommercialProjectionFunctionSignature=keyof typeof projectionFunctions
/** Only release-owned, fixed projection identities are permitted. PostgreSQL
 * functions require to_regprocedure; relation presence cannot identify them. */
export async function hasCommercialFunctionForVerifiedPrefix(client:SqlClient,signature:CommercialProjectionFunctionSignature):Promise<boolean>{
  if(!Object.hasOwn(projectionFunctions,signature))throw new CommercialSchemaCompatibilityError('unknown commercial projection function')
  const present=(await client.query<{present:boolean}>('SELECT pg_catalog.to_regprocedure($1) IS NOT NULL AS present',[signature])).rows[0]
  if(present?.present===true)return true
  return verifyMissingCommercialObjectPrefix(client,signature,projectionFunctions[signature])
}
/** A missing newly introduced relation is legal only in an actually verified
 * complete historical schema. Caller supplies a compile-time table/version,
 * never a request parameter or environment compatibility flag. */
export async function hasCommercialRelationForVerifiedPrefix(client:SqlClient,relationName:string,introducedVersion:number):Promise<boolean>{
  if(!/^[a-z][a-z0-9_]*$/.test(relationName)||!Number.isSafeInteger(introducedVersion)||introducedVersion<1)throw new CommercialSchemaCompatibilityError('invalid commercial relation identity')
  const relation=(await client.query<{present:boolean}>('SELECT pg_catalog.to_regclass($1) IS NOT NULL AS present',[`public.${relationName}`])).rows[0]
  if(relation?.present===true)return true
  // Default verifier accepts no unverified/null checksum or environment baseline.
  // Using the full release also rejects foreign/future migration identities.
  return verifyMissingCommercialObjectPrefix(client,relationName,introducedVersion)
}
