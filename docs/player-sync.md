# FlowBlock Sync

The launcher now performs a pull before launching Minecraft and a synchronization after the game process exits. The launcher stays open/minimized while Sync is enabled, including when the configured launch action is “close”. Closing its window during a game or transfer minimizes it so the post-game transfer can finish. Sync can be disabled from settings when idle.

The existing manual synchronization button now performs both downloads and uploads, including deletions. The user selection is intersected with the administrator's include/exclude rules. Configured roots can be selected even on a new installation with no local files. Default selections include saves, maps, waypoints, configurations and screenshots.

Local manifests are atomically saved under Electron's user-data directory, in `sync-manifests/<namespace>/manifest.json`. The namespace includes the AdminTool origin, verified Minecraft UUID, profile ID and instance directory. Previous upload-only version records are not treated as a trusted baseline; identical local/remote content is adopted and differing content requires a decision. The stable random device UUID is retained.

Each run compares the last synchronized content, current local content and remote manifest. SHA-256 determines content equality. Unchanged files are not uploaded. Revision checks reuse cached manifests; pagination restarts if the remote revision changes. Rules changing invalidate the cache. Remote tombstones propagate deletions; missing remote metadata after a reset or retention period causes a conflict when a baseline still exists.

Conflicts preserve local and remote data. In settings, synchronize and choose the local or remote version for each conflicting path. Choosing remote first backs up existing local content under the namespace's `conflict-backups/` directory. A decision is rejected if the local hash or remote version changed since it was displayed. The launcher does not start a new game until pre-game conflicts are resolved or Sync is disabled.

Downloads use temporary files, verify both SHA-256 and byte length and check that the destination has not changed before replacement. Uploads use a stable snapshot. Relative-path validation rejects traversal, Windows aliases/streams and symbolic links/junctions. Case collisions are rejected on Windows/macOS. A single transfer/game reservation prevents manual uploads while Minecraft is writing files. Switching accounts during a transfer aborts it before another player's token can be used in that namespace.

Failures preserve local files and completed per-file baselines so retrying resumes safely. A post-game failure or conflict is shown in the launcher. A corrupt settings/manifest file is reported instead of silently discarding the baseline.

Run `npm run test:sync`, `npx tsc --noEmit` and `npm run check:electron`. Tests use two temporary filesystem instances and simulated HTTP/storage; they require no real player account. Production S3, PostgreSQL and Minecraft login still need deployment integration testing.
