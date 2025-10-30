# Rapid Change Solo

Simple rapid tool change workflow helper for single-pocket manual tool changers.

## Installation

Install this plugin in ncSender through the Plugins interface.

## Features

### Tool Change Automation
- Automated M6 tool change sequence with spindle engagement
- Separate load and unload routines with safety confirmations
- $POCKET1 macro command support for manual positioning
- Same-tool change detection and skipping

### Tool Length Setter Integration
- Automated tool length probing with $TLS command
- Computed TLS position based on pocket location and orientation
- Configurable probe parameters (seek distance, feedrate)
- Automatic tool offset management

### Safety Features
- Modal dialogs for load/unload confirmation
- 1-second long-press requirement to prevent accidental triggers
- Visual progress indicators on buttons
- Non-closable safety dialogs during critical operations
- Clear instructions with emphasized safety warnings

### Configuration
- Pocket location (X/Y/Z coordinates)
- Tool setter location (X/Y coordinates)
- Advanced JSON-configurable parameters:
  - Z-axis positions (engagement, safe, spin-off, retreat)
  - RPM settings (load/unload)
  - Engagement feedrate
  - Tool length setter parameters

### Automatic Settings Management
- Sets tool count to 0 (single-pocket system)
- Enables manual tool change mode when configured
- Enables TLS integration when configured
- Resets settings on plugin disable

## Usage

1. Configure the pocket location using the "Grab" button while positioned at the pocket
2. Configure the tool setter location using the "Grab" button while positioned at the tool setter
3. Save configuration
4. Use M6 commands in your G-code for automated tool changes
5. Use $TLS command for tool length measurement
6. Use $POCKET1 command for manual pocket positioning

## Development

This plugin is part of the ncSender ecosystem: https://github.com/siganberg/ncSender

## License

See main ncSender repository for license information.
