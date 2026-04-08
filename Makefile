.PHONY: start dev link install clean

start:
	bun run bin/yt-down.ts

dev:
	bun run --watch bin/yt-down.ts

link:
	bun link

install:
	bun install

clean:
	rm -rf node_modules bun.lock
