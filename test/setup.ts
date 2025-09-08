// ESM-friendly globals + common fixes
import { expect } from '@jest/globals';

// Export commonly used Jest globals for tests
export {
  expect,
  describe,
  it,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  jest,
} from '@jest/globals';

// Add any common test polyfills/mocks here
// Example: global test configuration, shared mocks, etc.
