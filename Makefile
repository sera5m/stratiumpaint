# Thin wrappers; npm scripts do the real work. Uninstall: see scripts/uninstall.sh --help.
.PHONY: build test uninstall uninstall-dry-run purge

build:
	node scripts/bundle-standalone.mjs

test:
	node --test test/*.test.mjs

# Removes the Arch package (sudo pacman -R stratum) and the home-folder update copy; keeps settings.
uninstall:
	sh scripts/uninstall.sh

uninstall-dry-run:
	sh scripts/uninstall.sh --dry-run

# Same as uninstall, plus settings and unfinished-work copies in ~/.config/stratum.
purge:
	sh scripts/uninstall.sh --purge
