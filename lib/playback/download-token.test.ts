import { describe, expect, it } from "vitest";
import { createStreamTokenHandler } from "@/lib/playback/stream-token";
import { verifyMediaToken } from "@/lib/media-gateway/token";
import type { StreamTokenDeps } from "@/lib/playback/stream-token";

const secret=new Uint8Array(32).fill(8);
const now=1790000000000;
function world() {
  const state={signedIn:true,entitled:true,published:true};
  const calls={session:0,decision:0};
  const deps: StreamTokenDeps={accountsConfigured:()=>true,
    currentUser:async()=>{calls.session++;return state.signedIn?{id:'00000000-0000-4000-8000-000000000051',email:null}:null;},
    decide:async(user,id)=>{calls.decision++;return !user?{allowed:false,reason:'authentication_required'}:
      !state.entitled?{allowed:false,reason:'not_entitled'}:!state.published?{allowed:false,reason:'unavailable'}:{allowed:true,movieVersionId:id,subject:user.id};},
    loadConfig:()=>({secret,gatewayOrigin:'https://media.velora.example'}),now:()=>now};
  return {state,calls,post:createStreamTokenHandler(deps,'download')};
}
const request=(body:unknown={movieVersionId:1},site='same-origin')=>new Request('https://velora.example/api/media/download-token',
  {method:'POST',headers:{'Content-Type':'application/json','Sec-Fetch-Site':site},body:JSON.stringify(body)});
describe('download capability issuer and fresh renewal',()=>{
  it('issues only download URL + expiry and a scoped 10-minute capability',async()=>{
    const response=await world().post(request());const body=await response.json();expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');expect(Object.keys(body).sort()).toEqual(['downloadUrl','expiresAt']);
    const url=new URL(body.downloadUrl);expect(url.pathname).toBe('/v1/movie-versions/1/download');
    const verified=verifyMediaToken(secret,url.searchParams.get('token')!,{op:'download',movieVersionId:1,nowSeconds:now/1000,maxLifetimeSeconds:600});
    expect(verified.ok).toBe(true);expect(verified.ok&&verified.claims.exp-verified.claims.iat).toBe(600);
    expect(verifyMediaToken(secret,url.searchParams.get('token')!,{op:'stream',movieVersionId:1,nowSeconds:now/1000,maxLifetimeSeconds:3600})).toEqual({ok:false,code:'wrong_operation'});
  });
  it.each([['signedIn',401],['entitled',403],['published',404]] as const)('renewal rechecks %s and refuses revoked access',async(field,status)=>{
    const w=world();expect((await w.post(request())).status).toBe(200);w.state[field]=false;
    expect((await w.post(request())).status).toBe(status);expect(w.calls).toEqual({session:2,decision:2});
  });
  it('cannot exchange a capability or choose a user, operation or Telegram location',async()=>{
    for(const extra of [{token:'old'},{subject:'another'},{op:'stream'},{chat_id:'private'}]) {
      const w=world();expect((await w.post(request({movieVersionId:1,...extra}))).status).toBe(400);expect(w.calls.session).toBe(0);
    }
  });
  it('rejects cross-site issuance before auth or signing',async()=>{
    const w=world();expect((await w.post(request(undefined,'cross-site'))).status).toBe(403);expect(w.calls.session).toBe(0);
  });
});
