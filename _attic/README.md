# Attic Directory

This directory contains quarantined code that has been identified as potentially unused or deprecated. Files here are preserved for safety during refactoring but are not part of the active codebase.

## Quarantine Process

1. **Detection**: Files are identified as candidates for removal through static analysis tools (knip, ts-prune, depcheck)
2. **Quarantine**: Rather than deleting immediately, files are moved here with stub re-exports at original locations
3. **Verification**: After quarantine, monitor for any runtime issues over a period of time
4. **Cleanup**: Once confirmed safe, files can be permanently deleted

## Structure

Files maintain their original relative path structure within this directory for easy reference and potential restoration.

## Restoration

If a quarantined file is needed:
1. Move it back to its original location
2. Remove the stub file
3. Update any necessary imports
4. Commit with explanation of why it was needed

## Safety

- All quarantined files have stub re-exports to prevent immediate breakage
- Original commit hashes are preserved in stub comments for traceability
- No behavior changes should occur during the quarantine process
