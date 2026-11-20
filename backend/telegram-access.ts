import type {Request,Response,NextFunction} from 'express';
type Session={id?:number;rol?:unknown};
type Dependencies={readSession:(req:Request)=>Session|null;isLegacyAdmin:(role:unknown)=>boolean;isClubAdmin:(id:number|undefined)=>Promise<boolean>};
export const isTelegramContextRoute=(path:string)=>/^\/telegram\/context(?:\/|$)/u.test(path);
// Club administrators are verified against the active central membership, never a display label.
export function createTelegramContextAccess(deps:Dependencies){return async(req:Request,res:Response,next:NextFunction)=>{
 const session=deps.readSession(req);if(!session){res.status(401).json({error:'Sesión inválida o vencida. Inicia sesión nuevamente.'});return;}
 try{
  const allowed=deps.isLegacyAdmin(session.rol)||(Number.isSafeInteger(session.id)&&Number(session.id)>0&&await deps.isClubAdmin(session.id));
  if(!allowed){res.status(403).json({error:'Esta vista requiere permisos de administración.'});return;}
  res.locals.ceoSession=session;res.setHeader('Cache-Control','no-store');next();
 }catch{res.status(503).json({error:'No se pudieron comprobar los permisos. Inténtalo de nuevo.'});}
};}
