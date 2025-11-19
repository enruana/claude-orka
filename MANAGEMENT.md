# Claude-Orka Package Management Guide

This document explains how to maintain, build, and publish the Claude-Orka package to npm.

## Table of Contents

- [Prerequisites](#prerequisites)
- [Development](#development)
- [Building](#building)
- [Testing](#testing)
- [Publishing](#publishing)
- [Version Management](#version-management)
- [Maintenance](#maintenance)

---

## Prerequisites

### Required Accounts

1. **npm Account**
   - Create account at [npmjs.com](https://www.npmjs.com/signup)
   - Verify email
   - Enable 2FA (recommended)

2. **GitHub Account**
   - Create repository
   - Add project files
   - Configure repository settings

### Required Tools

```bash
# Node.js >= 18.0.0
node --version

# npm (comes with Node.js)
npm --version

# Git
git --version
```

---

## Development

### Local Setup

```bash
# Clone repository
git clone https://github.com/yourusername/claude-orka.git
cd claude-orka

# Install dependencies
npm install

# Link package globally for testing
npm link
```

### Development Scripts

```bash
# Watch mode (auto-rebuild on changes)
npm run dev

# Type checking (no output)
npm run type-check

# Run CLI locally
npm run orka -- <command>

# Build TypeScript
npm run build
```

### Making Changes

1. **Create a branch**
   ```bash
   git checkout -b feature/my-feature
   ```

2. **Make changes** to source files in `src/`

3. **Test locally**
   ```bash
   npm run build
   orka doctor  # Test CLI
   ```

4. **Commit changes**
   ```bash
   git add .
   git commit -m "feat: add new feature"
   ```

---

## Building

### Build Process

The build process compiles TypeScript to JavaScript:

```bash
npm run build
```

**What happens:**
- TypeScript files in `src/` → JavaScript in `dist/`
- Type declarations generated (`.d.ts` files)
- Source maps created for debugging

**Output structure:**
```
dist/
├── src/
│   ├── cli/          # CLI commands
│   ├── core/         # Core SDK
│   ├── models/       # Type definitions
│   └── utils/        # Utilities
└── ...
```

### Clean Build

```bash
# Remove dist folder
rm -rf dist

# Rebuild
npm run build
```

---

## Testing

### Manual Testing

#### 1. Test as Global Package

```bash
# Link globally
npm link

# Test commands
orka doctor
orka init
orka --help
```

#### 2. Test as Local Dependency

```bash
# Create test directory
mkdir /tmp/test-orka
cd /tmp/test-orka

# Link package
npm link claude-orka

# Test in code
cat > test.js << 'EOF'
import { ClaudeOrka } from 'claude-orka'
const orka = new ClaudeOrka(process.cwd())
await orka.initialize()
console.log('✓ Works!')
EOF

node test.js
```

#### 3. Test Package Contents

```bash
# Create tarball (doesn't publish)
npm pack

# This creates claude-orka-1.0.0.tgz
# Extract and inspect
tar -xzf claude-orka-1.0.0.tgz
ls package/
```

**Verify package includes:**
- ✅ `dist/` folder
- ✅ `bin/` folder
- ✅ `README.md`
- ✅ `package.json`
- ❌ `src/` folder (should NOT be included)
- ❌ `node_modules/` (should NOT be included)

---

## Publishing

### First Time Setup

1. **Login to npm**
   ```bash
   npm login
   ```

2. **Verify login**
   ```bash
   npm whoami
   ```

### Pre-publish Checklist

- [ ] All changes committed
- [ ] Version bumped in `package.json`
- [ ] `CHANGELOG.md` updated (if exists)
- [ ] Build succeeds (`npm run build`)
- [ ] Tests pass (manual or automated)
- [ ] `package.json` info correct (author, repo, etc.)
- [ ] README.md up to date

### Publishing to npm

#### Dry Run (Safe - Doesn't Publish)

```bash
# See what would be published
npm publish --dry-run
```

Review the output carefully!

#### Actually Publish

```bash
# Build and publish
npm publish
```

**What happens:**
1. Runs `prepublishOnly` script (builds package)
2. Creates tarball
3. Uploads to npm registry
4. Package is live!

#### Publish Specific Tag

```bash
# Publish as beta
npm publish --tag beta

# Users install with:
npm install -g claude-orka@beta
```

### Post-publish

1. **Verify on npm**
   - Visit `https://www.npmjs.com/package/claude-orka`
   - Check version, README, files

2. **Test installation**
   ```bash
   # In a clean directory
   npm install -g claude-orka
   orka --version
   ```

3. **Create GitHub release**
   - Go to GitHub → Releases → New Release
   - Tag version (e.g., `v1.0.0`)
   - Describe changes
   - Publish release

---

## Version Management

### Semantic Versioning

Claude-Orka follows [SemVer](https://semver.org/):

- **MAJOR** (1.0.0 → 2.0.0): Breaking changes
- **MINOR** (1.0.0 → 1.1.0): New features (backwards compatible)
- **PATCH** (1.0.0 → 1.0.1): Bug fixes

### Bumping Versions

#### Using npm (Recommended)

```bash
# Patch (1.0.0 → 1.0.1)
npm version patch

# Minor (1.0.0 → 1.1.0)
npm version minor

# Major (1.0.0 → 2.0.0)
npm version major
```

This automatically:
- Updates `package.json`
- Creates git commit
- Creates git tag

#### Manual

1. Edit `package.json`:
   ```json
   {
     "version": "1.0.1"
   }
   ```

2. Commit:
   ```bash
   git add package.json
   git commit -m "chore: bump version to 1.0.1"
   git tag v1.0.1
   ```

### Publishing New Version

```bash
# 1. Make changes
# ...

# 2. Commit changes
git add .
git commit -m "feat: add new feature"

# 3. Bump version
npm version minor  # or patch/major

# 4. Push to GitHub
git push origin main --tags

# 5. Publish to npm
npm publish

# 6. Create GitHub release (optional but recommended)
```

---

## Maintenance

### Updating Dependencies

```bash
# Check for outdated packages
npm outdated

# Update specific package
npm update <package-name>

# Update all packages (careful!)
npm update

# Update to latest (breaking changes possible)
npm install <package-name>@latest
```

### Security

```bash
# Check for vulnerabilities
npm audit

# Fix automatically (safe fixes)
npm audit fix

# Fix all (may have breaking changes)
npm audit fix --force
```

### Deprecating Versions

```bash
# Deprecate a specific version
npm deprecate claude-orka@1.0.0 "Use version 1.1.0 or higher"

# Deprecate all versions (DON'T do this unless necessary!)
npm deprecate claude-orka "This package is no longer maintained"
```

### Unpublishing

⚠️ **WARNING**: Unpublishing is permanent and not recommended!

```bash
# Unpublish specific version (within 72 hours)
npm unpublish claude-orka@1.0.0

# Unpublish entire package (within 72 hours, requires justification)
npm unpublish claude-orka --force
```

**Better alternatives:**
- Deprecate the version instead
- Publish a new version with fixes

---

## Common Tasks

### Update README

1. Edit `README.md`
2. Commit changes
3. Bump patch version: `npm version patch`
4. Publish: `npm publish`

### Add New CLI Command

1. Create command file: `src/cli/commands/mycommand.ts`
2. Register in `src/cli/index.ts`
3. Build: `npm run build`
4. Test: `orka mycommand`
5. Bump minor version: `npm version minor`
6. Publish: `npm publish`

### Fix Bug

1. Fix the bug in `src/`
2. Build: `npm run build`
3. Test fix
4. Commit: `git commit -m "fix: description"`
5. Bump patch: `npm version patch`
6. Publish: `npm publish`

### Add SDK Method

1. Add method to `src/core/ClaudeOrka.ts`
2. Export types if needed in `src/models/`
3. Build: `npm run build`
4. Test programmatically
5. Update README with example
6. Bump minor: `npm version minor`
7. Publish: `npm publish`

---

## Troubleshooting

### "Package already exists"

You can't use a package name that's already taken on npm. Choose a different name.

### "You do not have permission to publish"

1. Check you're logged in: `npm whoami`
2. Check package name doesn't conflict with existing package
3. If you own it, check you have publish permissions

### "prepublishOnly script failed"

Your build is failing. Check:
```bash
npm run build
```
Fix TypeScript errors before publishing.

### "Cannot find module after npm link"

```bash
# Unlink
npm unlink -g claude-orka

# Rebuild
npm run build

# Relink
npm link
```

---

## Best Practices

1. **Always test before publishing**
   - Use `npm pack` to inspect
   - Test installation in clean directory

2. **Keep dependencies minimal**
   - Only include necessary dependencies
   - Use `devDependencies` for development tools

3. **Document breaking changes**
   - Update README
   - Add migration guide if needed
   - Use major version bump

4. **Tag releases on GitHub**
   - Helps users track changes
   - Enables GitHub Releases page

5. **Keep changelog**
   - Document all changes
   - Makes upgrading easier for users

---

## Resources

- [npm Documentation](https://docs.npmjs.com/)
- [Semantic Versioning](https://semver.org/)
- [npm Package Best Practices](https://docs.npmjs.com/packages-and-modules/contributing-packages-to-the-registry)
- [TypeScript Handbook](https://www.typescriptlang.org/docs/)

---

## Quick Reference

```bash
# Development
npm run build          # Build TypeScript
npm run dev            # Watch mode
npm link              # Link globally for testing

# Testing
npm pack              # Create tarball (dry run)
npm publish --dry-run # See what would be published

# Publishing
npm version patch     # Bump version
npm publish          # Publish to npm
git push --tags      # Push tags to GitHub

# Maintenance
npm outdated         # Check outdated packages
npm audit            # Check vulnerabilities
npm deprecate        # Deprecate version
```
