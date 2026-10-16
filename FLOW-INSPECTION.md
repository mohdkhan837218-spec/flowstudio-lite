# FLOW INSPECTION — flow.google.com ka asal naqsha
# Jaanch: 2026-10-14 raat, MK ne khud (Aslam ke hukm par)
# Hissa 1: Backend/program ki jaanch — asal page + uske asal JS bundle se (VERIFIED)
# Hissa 2: Signed-in UI ki jaanch (tile/menu labels) — browser task se aayegi, neeche judegi

## Hissa 1 — Backend naqsha (VERIFIED saboot)
- flow.google.com asal me Google ka "AiSandbox" Angular app hai (boq-labs-ai-sandbox); page ke andar `productName: 'AiSandboxAngularFrontend'` saaf likha mila.
- **API host: `aisandbox-pa.googleapis.com`** (page me seedha maujood). Ek aur host: `aisandbox-pa-webchannel.clients6.google.com` (streaming/push khabar ke liye).
- API gRPC-style proto services hain. Bundle me mile asal method naam:
  - `/google.internal.labs.aisandbox.proto.flow.v1.FlowService/StreamGenerateContent` — generation ek STREAMING call hai
  - `FlowService.GetWorkflow`, `FlowService.ListWorkflows`, `FlowService.ListUserWorkflows`, `FlowService.ListSceneWorkflows`, `FlowService.BatchGetSceneWorkflows`, `FlowService.GetSceneWorkflow`, `FlowService.UpdateSceneWorkflow`
  - `AiSandbox.GetWorkflow`, `AiSandbox.SearchProjectWorkflows`, `AiSandbox.SearchUserWorkflows`
- **Har generation ki pehchan = `workflowId`** (app ke routes bhi `edit/:workflowId` jaise hain). Submit ke baad ki saari khabar isi ID se bandhi hoti hai.
- **Media = FIFE URLs**: bundle me feature flags `enable_fife_media_urls` aur `enable_fife_media_url_for_upload` maujood — generated media Google ke FIFE system se serve hota hai, matlab **video ke link `*.googleusercontent.com` wale honge** (page me `lh3.googleusercontent.com` dikha). FIFE video links aksar lambay signed/token wale hote hain aur jaldi expire ho sakte hain — milte hi turant fetch lazmi.
- Shared media ka route roop: `flow/shared/:mediaType/:mediaShareId`.

## Capture layer ke liye nateeja (v2.8)
1. Network par sabse qeemti shikaar: **aisandbox-pa.googleapis.com ke responses** — inhi ke andar workflowId + haal + media link aate hain. Inhe pehle suno, body scan karo.
2. **googleusercontent.com ke video responses/URLs** — yahi asal file hai; JSON ke kisi bhi field me aaye, pattern se pakdo (.mp4 hona zaroori nahi — FIFE link bina extension ke bhi ho sakta hai; host + context se pehchano).
3. Pehchan workflowId se bandho; na mile to tile currentSrc cross-match, phir kram.
4. Dhyaan: ye app gRPC-web/proto bol sakti hai — kuch responses binary (grpc-web frames) bhi ho sakte hain; URL text unme bhi plain dikh sakta hai, isliye body ko text ke roop me scan karna bhi rakho (sirf JSON.parse par nirbhar mat raho).

## Hissa 2 — Signed-in UI (VERIFIED — asal project "NSR Ep10" ke andar, 2026-10-14 raat)
- Project URL roop: `https://flow.google.com/project/<uuid>`; tile kholne par editor: `.../project/<uuid>/edit/<uuid>`.
- **Tile par hover karne se sirf 3 icon aate hain: Favorite (heart), Reuse prompt, More options (⋮). DOWNLOAD KA BUTTON HOVER PAR HOTA HI NAHI** — v2.6/v2.7 ki hover ranneeti isiliye kabhi kaam kar hi nahi sakti thi.
- **Tile ke ⋮ menu ke asal items (tartib se)**: Favorite · Reuse prompt · Add to scene · Add to prompt · **Download** · Copy · Rename · Share · Publish to YouTube · Set project cover · Flag output · Move to trash. Download ka exact label menu me sirf **"Download"** hai ("Download media" NAHI).
- **Editor view ki top bar (tartib se)**: Back · (title) · 360P · media strip · Favorite · Share · **Download media** (download icon, exact label "Download media") · Move to trash · Hide history · More options (⋮) · Done editing scene. Matlab "Download media" SIRF editor view me hai — tile par click karke editor khulna + toolbar ka load hona dono lazmi hain; grid par ye button kabhi nahi milega.
- Editor ke ⋮ menu me download NAHI hai (Download project, help, about type ke items hain).
- **Player `<video>` element NAHI hai — `<canvas class="video-canvas">` hai.** Editor me video canvas/WebGL se chalta hai, isliye DOM se video src nikalna editor view me na-mumkin ke barabar hai. Grid tiles ka bartav alag ho sakta hai, par ye saboot backend-capture ko hi pakka rasta sabit karta hai.
- Prompt bar ka settings pill project ke hisaab se badalta hai (is project me "Video · 720p · 8s · x1" dikha) — per-project yaad rehta hai.
- Top bar me credits number NAHI dikhta; project view me "credits kam hain" wala banner + "Add AI credits" button dikhta hai.
