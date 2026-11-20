// Run on the verified central host as an operator, after a backup. Default: no writes.
import {readFile} from 'node:fs/promises';import {parseEnv} from 'node:util';import {execFileSync} from 'node:child_process';
export function databaseAccessSql(databaseUrl,{production=false}={}){const url=new URL(databaseUrl);if(!['127.0.0.1','localhost'].includes(url.hostname)||url.pathname!=='/superagente')throw Error('verified_central_loopback_required');
 const identifier='"'+decodeURIComponent(url.username).replaceAll('"','""')+'"',policy='CREATE POLICY telegram_context_backend_test_targets ON public.telegram_ingestion_targets FOR SELECT TO '+identifier+' USING(enabled AND is_test)';
 const productionPolicy='CREATE POLICY telegram_context_backend_production_targets ON public.telegram_ingestion_targets FOR SELECT TO '+identifier+" USING(NOT is_test AND public.telegram_central_scope_ready(bot_id,chat_id,club_group_id,proyecto_id,'context'))";
 const productionSql=production?'GRANT EXECUTE ON FUNCTION public.telegram_central_scope_ready(bigint,bigint,uuid,text,text,timestamptz) TO '+identifier+';'+"DO $policy$ BEGIN IF NOT EXISTS(SELECT FROM pg_policy WHERE polname='telegram_context_backend_production_targets' AND polrelid='public.telegram_ingestion_targets'::regclass) THEN EXECUTE '"+productionPolicy.replaceAll("'","''")+"';END IF;END $policy$;":'';
 return productionSql+'ALTER TABLE public.telegram_ai_egress OWNER TO '+identifier+'; ALTER TABLE public.telegram_agent_runs OWNER TO '+identifier+'; GRANT SELECT ON public.telegram_ingestion_targets TO '+identifier+';\n'+
  "DO $policy$ BEGIN IF NOT EXISTS(SELECT FROM pg_policy WHERE polname='telegram_context_backend_test_targets' AND polrelid='public.telegram_ingestion_targets'::regclass) THEN EXECUTE '"+policy.replaceAll("'","''")+"';END IF;END $policy$;";
}
if(process.argv.includes('--apply')||process.argv.includes('--plan')){
 const env=parseEnv(await readFile('/etc/lyn/backend.env','utf8')),sql=(await readFile(new URL('./telegram-context-schema.sql',import.meta.url),'utf8'))+'\n'+databaseAccessSql(env.DATABASE_URL,{production:process.argv.includes('--production-scope')});
 if(process.argv.includes('--apply'))execFileSync('runuser',['-u','postgres','--','psql','-X','-q','-v','ON_ERROR_STOP=1','superagente'],{input:sql,stdio:['pipe','pipe','pipe']});
 console.log(JSON.stringify({plan:!process.argv.includes('--apply'),schema:'telegram-context',scope:'central-backend-owner-and-test-target-select-policy'}));
}
