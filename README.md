# claude-code-proxy

Claude-Code-Proxy is a project designed to run claude code on a central machine, in a sandboxed environment, where it can write code, make commits, run tests, etc.

The functionality I need in addition to that is a way for other things to access the claude code interface and run things.

Other projects like CLIProxyAPI do this but they circumvent anthropic's ToS by "Faking" requests coming from claude code.  I need to actually USE the claude code install.  This will help with authentication later because I MUST use my Claude Max subscription for this so OAuth with claude code is required.  The old claude-code npm libraries do not work anymore either that used the OAUTH environment variable.
