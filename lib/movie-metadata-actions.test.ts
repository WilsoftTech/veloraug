
import {it,expect,vi,beforeEach} from "vitest";
import {saveMovieMetadata} from "../app/admin/catalogue/actions";
import {GET} from "../app/posters/[file]/route";
const mocks=vi.hoisted(()=>({require:vi.fn(),client:vi.fn(),store:vi.fn(),read:vi.fn()}));
vi.mock("@/lib/discovery/runtime",()=>({requireReviewAdmin:mocks.require,reviewMode:()=>"database",databaseReviewClient:mocks.client}));
vi.mock("@/lib/artwork-storage",()=>({storePoster:mocks.store,readPoster:mocks.read}));
vi.mock("next/cache",()=>({revalidatePath:vi.fn()}));
vi.mock("next/navigation",()=>({redirect:vi.fn()}));
beforeEach(()=>{vi.clearAllMocks();mocks.require.mockResolvedValue({});});
const id="11111111-1111-4111-8111-111111111111";
function form(){const data=new FormData();for(const [k,v]of Object.entries({target:"catalogue",id:"1",updatedAt:"2026-11-12T00:00:00Z",title:"Manual",releaseDate:"2024-05-01"}))data.set(k,v);return data;}
it("authorizes before uploading any device file",async()=>{
 mocks.require.mockRejectedValueOnce(new Error("admin_required"));
 await expect(saveMovieMetadata({},form())).rejects.toThrow("admin_required");
 expect(mocks.store).not.toHaveBeenCalled();expect(mocks.client).not.toHaveBeenCalled();
});
it("refuses stale movie edits before uploading",async()=>{
 const save=vi.fn();mocks.client.mockResolvedValue({capabilities:async()=>({publish:true}),movieMetadata:async()=>({updated_at:"2026-11-12T00:00:01Z"}),saveMovieMetadata:save});
 const result=await saveMovieMetadata({},form());expect(result.error).toContain("changed");expect(mocks.store).not.toHaveBeenCalled();expect(save).not.toHaveBeenCalled();
});
it("preserves existing artwork and saves metadata without rights or publication commands",async()=>{
 const save=vi.fn();const metadata={poster_path:"/old.jpg",backdrop_path:null};
 mocks.client.mockResolvedValue({capabilities:async()=>({publish:true}),movieMetadata:async()=>({updated_at:"2026-11-12T00:00:00Z",metadata,slug:"manual"}),saveMovieMetadata:save});
 expect((await saveMovieMetadata({},form())).notice).toContain("saved");
 expect(save).toHaveBeenCalledWith(1,"2026-11-12T00:00:00Z",expect.objectContaining({poster_path:"/old.jpg",title:"Manual"}));expect(mocks.store).not.toHaveBeenCalled();
});
it("delivers fixed poster routes with safe errors and cache headers",async()=>{
 const context={params:Promise.resolve({file:id+".webp"})};
 const invalid=await GET(new Request("http://localhost/posters/x?w=343"),context);expect(invalid.status).toBe(404);expect(mocks.read).not.toHaveBeenCalled();
 mocks.read.mockResolvedValue({bytes:new Uint8Array([1,2,3]),etag:'"etag"'});
 const response=await GET(new Request("http://localhost/posters/x?w=342"),context);expect(response.status).toBe(200);expect(response.headers.get("content-type")).toBe("image/webp");expect(response.headers.get("x-content-type-options")).toBe("nosniff");
 expect((await GET(new Request("http://localhost/posters/x?w=342",{headers:{"if-none-match":'"etag"'}}),context)).status).toBe(304);
 mocks.read.mockRejectedValueOnce(new Error("private detail"));const failed=await GET(new Request("http://localhost/posters/x?w=342"),context);expect(failed.status).toBe(503);expect(await failed.text()).toBe("");
});
