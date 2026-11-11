Feature: The pinned tools are first on the PATH of every shell
  Persistent shims make the same tool commands work in interactive shells,
  in agents and in the apps that inherit a shell's PATH. Setting the PATH up
  is repeatable and never rewrites what a person put in a startup file.

  Rule: Every shell finds the pinned shims first
    In these scenarios {home}, {shims} and {tools} stand for the directories
    of the background, and {pinned directories} for the shims and the tools
    as one PATH entry, quoted for the shell.

    Background:
      Given a home directory with the tool directory "tool's bin" and the shims directory "tool shims"
      And "fleet-tool" in the shims directory prints "managed"

    @bash
    Scenario: PATH setup migrates old blocks before Bash early returns without clobbering user config
      An earlier version appended an unguarded block; many ".bashrc" files
      return early in a shell that is not interactive, before reaching it.
      Given ".bashrc" in the home directory reads:
        """
        case $- in *i*) ;; *) return ;; esac
        # user config

        # dev-fleet toolchain
        export PATH={pinned directories}:"$PATH"
        """
      And ".bash_profile" in the home directory reads:
        """
        # existing login config
        """
      And the shell PATH has been set up
      When the shell PATH is set up again
      Then ".bashrc" in the home directory is unchanged
      And ".bashrc" in the home directory contains:
        """
        case $- in *i*) ;; *) return ;; esac
        # user config
        """
      And ".bashrc" in the home directory contains "# dev-fleet toolchain" 1 time
      And ".bash_profile" in the home directory contains "# existing login config"
      And a noninteractive Bash with the PATH "/usr/bin:/bin" that reads ".bashrc" on startup can run "fleet-tool"
      And it prints "managed"
      And it prints nothing to standard error

    @zsh
    Scenario: Noninteractive zsh finds shims quietly and honors ZDOTDIR
      A nested shell does not add the directories a second time.
      Given zsh keeps its startup files in "zsh config" in the home directory
      When the shell PATH is set up
      Then the home directory holds no ".bash_profile"
      And the home directory holds no ".zshenv"
      And a noninteractive zsh with the PATH "/usr/bin:/bin" can run:
        """
        fleet-tool; zsh -c 'fleet-tool; print -r -- "$PATH"'
        """
      And it prints the line "managedmanaged{shims}:{tools}:/usr/bin:/bin"
      And it prints nothing to standard error

    @bash
    Scenario: Pinned shims stay first even after later PATH edits in the same file
      A version manager or a vendor's installer prepends its own directory
      later in the file.
      Given "fleet-tool" in the directory "stray" of the home directory prints "stray"
      And ".bashrc" in the home directory reads:
        """
        export PATH='{home}/stray':"$PATH"
        """
      And the shell PATH has been set up
      When the shell PATH is set up again
      Then ".bashrc" in the home directory is unchanged
      And a noninteractive Bash with the PATH "/usr/bin:/bin" that reads ".bashrc" on startup can run "fleet-tool"
      And it prints "managed"

  Rule: A block is added to a startup file once, after what is there

    Scenario: Appending a block again preserves the file and does not duplicate the block
      Given "profile" in the home directory reads:
        """
        # user config
        """
      And this block has been appended to "profile" in the home directory:
        """
        # managed
        export PATH=example
        """
      When the same block is appended to "profile" in the home directory again
      Then "profile" in the home directory is unchanged
      And "profile" in the home directory still starts with the line "# user config"

  Rule: The mise data location follows native Windows and XDG overrides

    Scenario Outline: On <platform> with <setting>, mise keeps its data in <directory>
      When the mise data directory is located on "<platform>" for the home "/user", with <setting>
      Then mise keeps its data in "<directory>"

      Examples:
        | platform | setting                     | directory               |
        | win32    | LOCALAPPDATA=/windows/local | /windows/local/mise     |
        | linux    | nothing set                 | /user/.local/share/mise |
        | win32    | MISE_DATA_DIR=/custom       | /custom                 |
        | darwin   | XDG_DATA_HOME=/xdg          | /xdg/mise               |
