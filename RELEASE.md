# Release Checklist

For repository setup and release body template, see GITHUB.md.

## Steps to Publish a Release

1. Bump the version in `package.json`
2. Update `CHANGELOG` / commit history as needed
3. Tag the commit: `git tag vX.Y.Z`
4. Push the tag: `git push origin vX.Y.Z`
5. Create the GitHub release using the template in GITHUB.md
6. Attach any build artifacts (packaged binaries, Docker image tags)

## Requirements

- Node.js 18+ or Docker
- Steam accounts with MAFiles for 2FA

## Notes

- Steam credentials are stored locally in SQLite
- For production, use HTTPS via reverse proxy
