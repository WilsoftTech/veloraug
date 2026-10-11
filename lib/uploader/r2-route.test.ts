import { beforeEach,describe,it,expect,vi } from "vitest";
const mocks=vi.hoisted(()=>({client:vi.fn(),storage:vi.fn(),resume:vi.fn(),sign:vi.fn(),complete:vi.fn()}));
vi.mock("./admin-runtime",()=>({uploadClient:mocks.client}));
vi.mock("./r2",async original=>({...await original<typeof import("./r2")>(),createR2Storage:mocks.storage}));
vi.mock("./r2-control",async original=>({...await original<typeof import("./r2-control")>(),resumeR2Upload:mocks.resume,signR2Part:mocks.sign,completeR2Upload:mocks.complete}));
import { r2UploadResponse } from "./r2-route";
beforeEach(()=>{vi.resetAllMocks();mocks.client.mockResolvedValue({r2:vi.fn()});mocks.storage.mockReturnValue({});});
const request=(body:string)=>new Request("https://velora.example/api/admin/uploads/uuid/transfer",{method:"POST",headers:{"content-type":"application/json"},body});
describe("bounded R2 control route",()=>{
  it("requires fresh authorization before creating a storage client",async()=>{
    mocks.client.mockRejectedValue(new Error("upload_not_authorized"));expect((await r2UploadResponse(request('{"command":"status"}'),"uuid")).status).toBe(403);expect(mocks.storage).not.toHaveBeenCalled();
  });
  it("never accepts a movie body or oversized control payload",async()=>{
    expect((await r2UploadResponse(request("x".repeat(4097)),"uuid")).status).toBe(413);expect(mocks.storage).not.toHaveBeenCalled();
  });
  it("rejects caller-selected bucket, key, ownership and unknown commands",async()=>{
    for(const input of [{command:"status",key:"another-user"},{command:"status",bucket:"public"},{command:"status",owner:"another-user"},{command:"delete"}])expect((await r2UploadResponse(request(JSON.stringify(input)),"uuid")).status).toBe(400);
    expect(mocks.storage).not.toHaveBeenCalled();
  });
  it("returns only the short-lived part capability after valid input",async()=>{
    mocks.sign.mockResolvedValue({url:"https://r2.example/temporary",expiresIn:300,number:1,size:3});
    const response=await r2UploadResponse(request(JSON.stringify({command:"sign",number:1,sha256:"a".repeat(64)})),"uuid");
    expect(response.status).toBe(200);expect(response.headers.get("cache-control")).toBe("no-store");expect(await response.json()).toEqual({url:"https://r2.example/temporary",expiresIn:300,number:1,size:3});
  });
});
