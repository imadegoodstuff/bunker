# Contribution #1 to transact4x2

- participant: scash coordinator
- date: 2026-10-13T10:45:13.342Z
- input zkey blake2b: `abbc9824583092850cdc9e3af3c928011a16a847cee826b0d577b31da4f3442c56e04040a9fef181fbeed94ebbf800ee98fb178686e2898d858cfed2c5f094d8`
- output zkey (`transact4x2_0001.zkey`) blake2b: `cdfe3d104dd449413785c0d77ece2fcaafbd2e52028f7724274c3c4c4786b058b12cf7d125ceb935a508870f4a3dcda38fc0faac99ecfc4896b8768cc436c9aa`
- contribution hash: `8b42357f7e783482b2664cbd4e66814d24b2cdef44847f344103e2e385565f14400e857c4386d66015d589ed9ac2a841a779a4d597c4de89b3689eacdf51fc51`

I ran `node circuits/scripts/ceremony.mjs contribute` from a clean checkout at
the commit that pins the r1cs hash in `ceremony/transcript.json`, mixed my own
entropy into the prompt, and destroyed the machine state afterwards.

<!-- Sign this file (gpg --clearsign, or paste a signature from a key tied to
     the handle above) and add a link to a public post of the contribution
     hash. Then open a PR adding this file and the transcript entry. -->
