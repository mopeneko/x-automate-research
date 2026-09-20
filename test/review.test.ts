import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditSummary, claimLines, evidenceFor, needsReview, reviewSummary, validateReplacements } from "../src/review.ts";
import type { ClaimReview } from "../src/review.ts";
import { previewComparison } from "../src/preview.ts";
import { Store } from "../src/store.ts";
import type { Tweet } from "../src/types.ts";
const post: Tweet = { id: "1", author: "test", createdAt: "2026-09-19T12:00:00Z", text: "ZECのショートは部分ヘッジと解釈できる。", isReply: false, isRetweet: false, isQuote: false };
const config = { apiKey: "test", model: "jev-1.13.0" };
const originalFetch = globalThis.fetch;
const dirs: string[] = [];
afterEach(async () => { globalThis.fetch = originalFetch; await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true }))); });
function response(verdict: "issue" | "clear" | "unknown") {
 const answer = { type: "choice", choice: verdict, confidence: 0.9, probabilities: { issue: verdict === "issue" ? 0.9 : 0.05, clear: verdict === "clear" ? 0.9 : 0.05, unknown: verdict === "unknown" ? 0.9 : 0.05 } };
 return Response.json({ model: config.model, answers: { certainty: answer, meaning: answer } });
}
function fetcher(fn: (init: RequestInit) => Response | Promise<Response>): typeof fetch {
 return (async (_url: unknown, init?: RequestInit) => fn(init!)) as typeof fetch;
}
const target: ClaimReview = { line: 2, text: "・ZECは38Kのショートでヘッジを形成している。", sourceIds: ["1"], status: "unavailable" };

test("extract lines preserves indices and skips headings/sentiment labels", () => {
 expect(claimLines("〖概況〗\n\n・ZEC上昇\n強気\n理由:買い優勢")).toEqual([{ line: 2, text: "・ZEC上昇" }, { line: 4, text: "理由:買い優勢" }]);
});
test("retrieval selects source candidates within bounded context, preserves updates", () => {
 const posts = [{ ...post, id: "later", text: "BTCの86.5Kの清算が消えた。", createdAt: "2026-09-19T13:00:00Z" }, { ...post, id: "earlier", text: "BTCの86.5Kの清算が巨大。" }, { ...post, id: "noise", text: "おむつゴミ箱" }];
 expect(evidenceFor("BTCの86.5Kの清算", posts).map(p=>p.id)).toEqual(["earlier", "later"]);
 expect(evidenceFor("ZEC", [{ ...post, text: "ZEC".repeat(10000) }])).toEqual([]);
});
test("no evidence and malformed API remain unchecked", async () => {
 const none = await auditSummary("・unknownword", [post], config, { fetcher: fetcher(()=>{throw Error("must not call");}) });
 expect(none.status).toBe("unavailable");
 expect(none.uncheckedLines).toBe(1);
 const bad = await auditSummary("・ZEC", [post], config, { fetcher: fetcher(()=>Response.json({ answers: {} })) });
 expect(bad.status).toBe("unavailable");
});
test("deadline stops hung request and reports unavailable", async () => {
 const report = await auditSummary("・ZEC", [post], config, { budgetMs: 10, fetcher: fetcher((init)=>new Promise((_resolve,reject)=>init.signal!.addEventListener("abort",()=>reject(Error("timeout")),{once:true}))) });
 expect(report.status).toBe("unavailable");
});
test("repair is scoped, preserves other lines, and requires a successful recheck", async () => {
 const draft="〖概況〗\n・ZECは部分ヘッジを形成している。\n\n強気";
 let calls=0;
 const report=await reviewSummary(draft,[post],config,async items=>{
  expect(items[0]!.line).toBe(1);
  expect(items[0]!.sources[0]!.id).toBe("1");
  return {replacements:[{line:1,text:"・ZECのショートは部分ヘッジと解釈できる。"}]};
 },{fetcher:fetcher(()=>response(++calls===1?'issue':'clear'))});
 expect(report.appliedLines).toEqual([1]);
 expect(report.final).toBe("〖概況〗\n・ZECのショートは部分ヘッジと解釈できる。\n\n強気");
 expect(report.unresolvedLines).toEqual([]);
});
test("uncertainty routes to review, never becomes proof of an error", async () => {
 const report=await reviewSummary("・ZEC",[post],config,async items=>{
  expect(items[0]!.reasons[0]).toContain("誤りとは限らない");
  return {replacements:[]};
 },{fetcher:fetcher(()=>response('unknown'))});
 expect(report.final).toBe("・ZEC");
 expect(report.unresolvedLines).toEqual([0]);
 expect(needsReview(report.before.claims[0]!)).toBe(true);
});
test.each(['issue','unknown'] as const)("unresolved %s recheck preserves original",async verdict=>{
 let calls=0;
 const draft="・ZECはヘッジを形成";
 const report=await reviewSummary(draft,[post],config,async()=>({replacements:[{line:0,text:"・ZECはヘッジと見られる"}]}),{fetcher:fetcher(()=>response(++calls===1?'issue':verdict))});
 expect(report.final).toBe(draft);
 expect(report.appliedLines).toEqual([]);
 expect(report.unresolvedLines).toEqual([0]);
});
test("API and repair failures preserve draft and are recorded",async()=>{
 const a=await reviewSummary("・ZEC",[post],config,async()=>{throw Error("must not call");},{fetcher:fetcher(()=>new Response('',{status:429}))});
 expect(a.before.status).toBe('unavailable');
 const b=await reviewSummary("・ZEC",[post],config,async()=>{throw Error("repair down");},{fetcher:fetcher(()=>response('issue'))});
 expect(b.repairStatus).toBe('failed');
 expect(b.final).toBe('・ZEC');
});
test("reject structural edits, new line indices, duplicated edits, changed numeric values",()=>{
 for(const replacements of [
  [{line:3,text:'・ZEC'}], [{line:2,text:'・ZEC\n・追加'}], [{line:2,text:'〖新見出し〗'}],
  [{line:2,text:'・ZECは39Kのショート'}], [{line:2,text:target.text},{line:2,text:target.text}],
 ]) expect(()=>validateReplacements({replacements},[target])).toThrow();
 expect(validateReplacements({replacements:[{line:2,text:'・ZECは38Kのショートをヘッジと解釈できる。'}]},[target]).size).toBe(1);
});
test("claim cap marks excess lines unchecked instead of claiming complete review",async()=>{
 const report=await auditSummary(Array(50).fill('・ZEC').join('\n'),[post],config,{fetcher:fetcher(()=>response('clear'))});
 expect(report.claims).toHaveLength(48);
 expect(report.uncheckedLines).toBe(2);
 expect(report.status).toBe('partial');
});
test("review preview reuses one draft, saves audit, and never calls Telegram",async()=>{
 const dir=await mkdtemp(join(tmpdir(),'review-test-')); dirs.push(dir);
 const store=new Store(dir,'crypto'); await store.init(); await store.appendPosts('2026-09-19',[post]);
 let geminiCalls=0;
 globalThis.fetch=(async(url:unknown,init?:RequestInit)=>{
  if(String(url).includes('typesafe'))return response('clear');
  expect(String(url)).toContain('generativelanguage'); geminiCalls++;
  return Response.json({candidates:[{content:{parts:[{text:'・ZECのショートは部分ヘッジと解釈できる。'}]},finishReason:'STOP'}]});
 }) as typeof fetch;
 const out=await previewComparison({geminiApiKey:'test',socialdataApiKey:'test',telegramBotToken:'test',storeDir:dir,pipelines:[{id:'crypto',listId:'1',telegramChatId:'1'}],jev:config},'crypto','2026-09-19','夜場');
 expect(geminiCalls).toBe(1);
 expect(await Bun.file(join(out,'jev.txt')).text()).toBe(await Bun.file(join(out,'baseline.txt')).text());
 expect((await Bun.file(join(out,'audit.json')).json()).before.status).toBe('complete');
 expect(await store.readWindowSummaries('2026-09-19')).toEqual({});
});

test("one invalid numeric edit does not discard an independent valid repair",async()=>{
 let calls=0;
 const draft='・ZECは38Kをヘッジしている。\n・ZECはヘッジしている。';
 const result=await reviewSummary(draft,[post],config,async()=>({replacements:[{line:0,text:'・ZECは39Kをヘッジしている。'},{line:1,text:'・ZECはヘッジと解釈できる。'}]}),{fetcher:fetcher(()=>response(++calls<=2?'issue':'clear'))});
 expect(result.rejectedEdits).toBe(1);
 expect(result.appliedLines).toEqual([1]);
 expect(result.final.split('\n')[0]).toBe(draft.split('\n')[0]!);
});

test("repair uses Standard and skips unavailable models without profile retries",async()=>{
 const {GeminiSummarizer}=await import('../src/gemini.ts');
 const urls:string[]=[];
 globalThis.fetch=(async(url:unknown,init?:RequestInit)=>{
  urls.push(String(url));
  const body=JSON.parse(init!.body as string);
  expect(body.service_tier).toBeUndefined();
  expect(body.systemInstruction.parts[0].text).toContain('校正担当');
  if(urls.length===1)return new Response('model not found',{status:404});
  return Response.json({candidates:[{content:{parts:[{text:'{"replacements":[]}'}]},finishReason:'STOP'}]});
 }) as typeof fetch;
 expect(await new GeminiSummarizer('test').repairClaims([])).toEqual({replacements:[]});
 expect(urls).toHaveLength(2);
 expect(urls[0]).toContain('gemini-3.8-flash');
 expect(urls[1]).toContain('gemini-3.5-flash');
});
