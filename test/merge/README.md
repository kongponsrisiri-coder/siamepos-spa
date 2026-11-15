# Client merge tests (SPA-CLIENT-MERGE-002)

Run against a THROWAWAY Postgres — the scripts wipe the client tables.

    export TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55432/spatest

1. Cloud rules (34 checks):  `node test/merge/merge-e2e.js`
2. Offline till round trip — start the fake cloud, then run a till under
   Electron's Node (the SQLite add-on is built for Electron):

       node test/merge/cloud.js &            # cloud on :55433
       ELECTRON_RUN_AS_NODE=1 electron/node_modules/.bin/electron test/merge/till.js /tmp/till1.db    # 21 checks
       # restart cloud.js (it reseeds), then:
       ELECTRON_RUN_AS_NODE=1 electron/node_modules/.bin/electron test/merge/till2.js /tmp/till2.db   # 8 checks

   till.js  = merge offline → pull (duplicate must not come back) → reconnect/upload.
   till2.js = another till re-points its own older history from a merge tombstone;
              a duplicate created offline merges without wedging the queue.
