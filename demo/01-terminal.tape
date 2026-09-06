Output "01-terminal.mp4"

Set FontSize 20
Set Width 1440
Set Height 810
Set Padding 40
Set Shell zsh
Set WindowBar Colorful
Set Theme "Catppuccin Mocha"
Set CursorBlink true

Sleep 800ms

# 1. install the skill (accept defaults: all agents)
Type@30ms "npx skills add codenamegary/redline"
Sleep 1s
Enter
Sleep 3s
Enter
Sleep 2s
Enter
Sleep 2s
Enter
Sleep 2s

# 2. launch opencode and ask for a cat patio redline
Type@30ms "opencode"
Sleep 1s
Enter
Sleep 6s
Type@20ms "Redline an interactive mobile app UI mockup and corresponding API contracts for a seating selector for a concert venue with 100 GA floor seats, 200 mezzanine seats and 300 balcony seats."
Sleep 1s
Enter
Sleep 5m


