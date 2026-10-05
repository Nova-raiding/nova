export interface CommercialAttesterInstallPlan {files:{path:string;contents:string;mode:number}[];directories:string[]}
export function planCommercialAttesterInstallation(args:string[],options?:{io?:any;uid?:number;now?:number;targetPrefix?:string}):CommercialAttesterInstallPlan
export function applyCommercialAttesterInstallation(plan:CommercialAttesterInstallPlan,options?:{io?:any}):{stage:string;createdFiles:string[];createdDirectories:string[]}
export class CommercialAttesterInstallError extends Error {stage:string;report:{createdFiles:string[];createdDirectories:string[];preserved:string[];rollbackErrors:string[]}}
