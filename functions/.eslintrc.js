module.exports = {
  // Define environments for browser, Node.js, and modern JavaScript
  env: {
    browser: true, // For React client-side code
    node: true, // For Firebase Functions
    es2023: true, // Support latest ECMAScript features (includes async/await)
  },
  // Extend recommended configurations for ESLint, JavaScript, and React
  extends: [
    'eslint:recommended', // Base ESLint recommended rules
    'plugin:react/recommended', // React-specific linting rules
    'plugin:react-hooks/recommended', // Rules for React Hooks
    'plugin:import/recommended', // Rules for import/export syntax
    'plugin:jsx-a11y/recommended', // Accessibility rules for JSX
    'plugin:promise/recommended', // Rules for Promises and async/await
  ],
  // Specify parser options for modern JavaScript
  parserOptions: {
    ecmaVersion: 2023, // Support ES2023 (latest as of 2025)
    sourceType: 'module', // Enable ES modules
    ecmaFeatures: {
      jsx: true, // Enable JSX parsing for React
    },
  },
  // Define plugins for additional linting capabilities
  plugins: [
    'react',
    'react-hooks',
    'import',
    'jsx-a11y',
    'promise',
  ],
  // Custom rules to enforce code quality and catch issues
  rules: {
    // General JavaScript rules
    'no-unused-vars': ['warn', { vars: 'all', args: 'after-used', ignoreRestSiblings: true }], // Warn on unused variables
    'no-console': ['warn', { allow: ['warn', 'error'] }], // Allow console.warn and console.error
    'eqeqeq': ['error', 'always'], // Enforce strict equality (===)
    'curly': ['error', 'all'], // Require curly braces for all control statements
    'no-await-in-loop': 'warn', // Warn on await in loops (performance concern)
    'require-await': 'error', // Ensure async functions use await
    'no-return-await': 'error', // Disallow unnecessary return await

    // React-specific rules
    'react/prop-types': 'off', // Disable prop-types (use TypeScript or defaultProps if needed)
    'react/jsx-uses-react': 'off', // Not needed with React 17+ (new JSX transform)
    'react/react-in-jsx-scope': 'off', // Not needed with React 17+ (new JSX transform)
    'react/jsx-no-duplicate-props': 'error', // Prevent duplicate props in JSX
    'react/no-unescaped-entities': 'error', // Prevent unescaped HTML entities in JSX

    // Import rules
    'import/no-unresolved': 'error', // Ensure imports resolve correctly
    'import/order': ['warn', { groups: [['builtin', 'external', 'internal']] }], // Enforce import order
    'import/no-extraneous-dependencies': ['error', { devDependencies: ['**/*.test.js', '**/*.spec.js'] }], // Prevent importing dev dependencies in production code

    // Accessibility rules
    'jsx-a11y/anchor-is-valid': ['error', { components: ['Link'], specialLink: ['to'] }], // Ensure valid anchors (e.g., for react-router)

    // Promise/async rules
    'promise/always-return': 'error', // Ensure async functions return a value or throw
    'promise/no-return-wrap': 'error', // Prevent wrapping values in Promise.resolve/reject
    'promise/catch-or-return': 'error', // Ensure promises are handled with catch or return
  },
  // Settings for specific plugins
  settings: {
    react: {
      version: 'detect', // Automatically detect React version
    },
    'import/resolver': {
      node: {
        extensions: ['.js', '.jsx'], // Resolve .js and .jsx files
      },
    },
  },
};