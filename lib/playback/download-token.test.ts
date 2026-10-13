import { describe, expect, it, vi } from "vitest";
import { downloadsEnabled } from "@/lib/playback/stream-capability";
import { createStreamTokenHandler } from "@/lib/playback/stream-token";
import { verifyMediaToken } from "@/lib/media-gateway/token";
import type { StreamTokenDeps } from "@/lib/playback/stream-token";

const secret=new Uint8Array(32).fill(8);
const now=1790000000000;
function world() {
  const state={signedIn:true,entitled:true,published:true,enabled:true};
  const calls={session:0,decision:0};
  const deps: StreamTokenDeps={accountsConfigured:()=>true,
    currentUser:async()=>{calls.session++;return state.signedIn?{id:'00000000-0000-4000-8000-000000000051',email:null}:null;},
    decide:async(user,id)=>{calls.decision++;return !user?{allowed:false,reason:'authentication_required'}:
      !state.entitled?{allowed:false,reason:'not_entitled'}:!state.published?{allowed:false,reason:'unavailable'}:{allowed:true,movieVersionId:id,subject:user.id};},
    loadConfig:()=>({secret,gatewayOrigin:'https://media.velora.example'}),now:()=>now,downloadsEnabled:()=>state.enabled};
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
  // Checkpoint 9: the server's download switch, on the issuing side.
  it('issues nothing while the switch is off: one fixed refusal before any session, catalogue or signing work',async()=>{
    const w=world();w.state.enabled=false;
    for(const body of [{movieVersionId:1},{movieVersionId:999},{movieVersionId:1,token:'old'},'not json']) {
      const response=await w.post(request(body));expect(response.status).toBe(503);expect(await response.json()).toEqual({error:'downloads_disabled'});
      expect(response.headers.get('cache-control')).toBe('no-store');
    }
    w.state.signedIn=false;expect((await w.post(request())).status).toBe(503);
    expect(w.calls).toEqual({session:0,decision:0});
    // On again, the next request is authorized afresh like any other.
    w.state.enabled=true;w.state.signedIn=true;expect((await w.post(request())).status).toBe(200);expect(w.calls).toEqual({session:1,decision:1});
  });
  it('is off when the handler is built without the switch, and a stream handler never reads it',async()=>{
    const deps: StreamTokenDeps={accountsConfigured:()=>true,currentUser:async()=>({id:'00000000-0000-4000-8000-000000000051',email:null}),
      decide:async(user,id)=>({allowed:true,movieVersionId:id,subject:user!.id}),loadConfig:()=>({secret,gatewayOrigin:'https://media.velora.example'}),now:()=>now};
    expect((await createStreamTokenHandler(deps,'download')(request())).status).toBe(503);
    const read=vi.fn(()=>false);
    const stream=await createStreamTokenHandler({...deps,downloadsEnabled:read},'stream')(request());
    expect(stream.status).toBe(200);expect(Object.keys(await stream.json()).sort()).toEqual(['expiresAt','streamUrl']);expect(read).not.toHaveBeenCalled();
  });
  it('reads the switch from the environment: only an exact true turns it on',()=>{
    for(const value of [undefined,'','false','TRUE','True','1','yes','on',' true','true ']) expect(downloadsEnabled({MEDIA_GATEWAY_DOWNLOADS_ENABLED:value}),String(value)).toBe(false);
    expect(downloadsEnabled({MEDIA_GATEWAY_DOWNLOADS_ENABLED:'true'})).toBe(true);
  });
  it('rejects cross-site issuance before auth or signing',async()=>{
    const w=world();expect((await w.post(request(undefined,'cross-site'))).status).toBe(403);expect(w.calls.session).toBe(0);
  });
});
