export const COMMERCIAL_RUNTIME_ENV_KEYS: readonly string[]
export function readCommercialRuntimeEnvironment(path:string):Record<string,string>
export function applyCommercialRuntimeCompose<T extends {services?:Record<string,unknown>}>(compose:T,env:Record<string,string>,options?:{production?:boolean}):T
