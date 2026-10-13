# Contribution #1 to transact2x2

- participant: scash coordinator
- date: 2026-10-13T10:45:08.192Z
- input zkey blake2b: `b2419a648802511c0ac4d4b2b4f6b31380b174fbc89a4f4fbb5d3e63c4eb14b11e93e2d70a33f6b3bfd58c8b5d01e17c63ee838c9fbcf9dcd29a0e54197115fb`
- output zkey (`transact2x2_0001.zkey`) blake2b: `ef9d7a932cccb7b842122754bbbdbb3f95e5e21dc7a808f78095df7e6969202628b3241a7a75226ffd0404594e98791c1fb89f2c0890bb434e8a7815ad50007f`
- contribution hash: `c1d43bb90ee8003a415c9782d72ab60ef1af6054983dd70f7b2e065296932643b901b2ec159cbb98aa212b4d4acdb784f77e064eede1075cac54cf5c8017ae4b`

I ran `node circuits/scripts/ceremony.mjs contribute` from a clean checkout at
the commit that pins the r1cs hash in `ceremony/transcript.json`, mixed my own
entropy into the prompt, and destroyed the machine state afterwards.

<!-- Sign this file (gpg --clearsign, or paste a signature from a key tied to
     the handle above) and add a link to a public post of the contribution
     hash. Then open a PR adding this file and the transcript entry. -->
