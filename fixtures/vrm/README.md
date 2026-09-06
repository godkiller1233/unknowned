# VRM test fixtures

Real `.vrm` models used by the regression harness:

```bash
node scripts/vrm-verify.mjs           # verify every fixture here
node scripts/vrm-verify.mjs --model meme.vrm
npm run verify:vrm                    # same as the first command
```

The harness loads each model through the **real 3D avatar engine path**
(`createAvatarEngine` mode `3d` → three.js GLTFLoader → bone/morph discovery →
rig driver → rendered frames) in headless Chromium with a synthetic tracker,
and asserts: tracking status, rendered frames, painted pixels, head/eye/jaw
rig discovery, morph-target mapping, hand-rig meshes, and zero page errors.

## Files

These are personal model files and are **not committed** (the directory is
gitignored). Source: the owner's Documents folder.

| File | Size | Notes |
|---|---|---|
| `death.vrm` | 16 MB | VRoid export, 60+ hair bones |
| `f.vrm` | 13 MB | VRoid export |
| `female memegod.vrm` | 19 MB | VRoid export, skirt bones (~127 secondary bones) |
| `meme.vrm` | 15 MB | VRoid export, hood + hair |
| `memegoddisc.vrm` | 18 MB | VRoid export |
| `new normal.vrm` | 16 MB | VRoid export |
| `vampire.vrm` | 15 MB | VRoid export |

Other model files from the same folder were **not** usable as fixtures:

- `memegodm1das.vrm`, `memegodm1dass.vrm`, `memegodmidasskin.vrm`,
  `student1.vrm`, `student11.vrm`, `student2.vrm` — **zero-byte** placeholder
  files
- `*.vroid` / `*.xroid` — VRoid Studio **project** files, not exportable VRM
  models (the engine can't load them)
- `memegodoriginal.xavatar` — a different application's project format

## Coverage notes (from the verification run)

- Every model maps 21–24 morph channels (ARKit/VRM names → blink, smile, jaw,
  brows) and discovers head + both eye bones.
- All models have `J_Sec_*` physics bones (hair/skirt/hood) that the engine's
  hair/cloth spring chains must pick up — the harness warns when none are
  found, which caught a real engine bug on these models.

One model renders slowly under SwiftShader (software GL) — the harness waits
for a target frame count with a time cap, so machine speed does not flip the
result. On real GPUs all models render at interactive rates.
