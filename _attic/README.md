# Attic — Code Quarantine

This directory contains code that has been identified as potentially unused but is being preserved for safety.

## Quarantine Process

1. **Evidence Collection**: Code is identified as unused via static analysis (knip, ts-prune, depcheck)
2. **Safe Quarantine**: Files are moved here maintaining their original directory structure
3. **Stub Creation**: Original locations get stub files with deprecation notices and links to attic location
4. **Observation Period**: Code remains quarantined to verify no runtime dependencies exist
5. **Final Removal**: After confirmation period, code can be safely deleted

## Structure

Files are organized maintaining their original path structure:
```
_attic/
├── src/utils/deadFunction.ts    # Was: src/utils/deadFunction.ts
├── scripts/oldScript.js         # Was: scripts/oldScript.js
└── docs/oldDoc.md              # Was: docs/oldDoc.md
```

## Restoration

To restore quarantined code:
1. Move file back to original location
2. Remove the stub file
3. Update imports if needed
4. Test functionality

## Commit Reference

This attic was established in commit: [will be updated when committed]