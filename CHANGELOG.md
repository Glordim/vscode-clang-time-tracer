# Change Log

All notable changes to the "clang-time-tracer" extension will be documented in this file.

## [1.2.0]
- Folder view (Heavy Headers / Header Impact): double-click on an item expands/collapses its inclusion list
- Folder view (Heavy Headers / Header Impact): expand/collapse is now animated
- Folder view (Heavy Headers / Header Impact): inclusion list sorted alphabetically by filename
- Build progress notification: long filenames no longer cause awkward line wraps

## [1.1.2]
- Fix robust command string parsing with proper quote and escape handling

## [1.1.1]
- Downgrade minimal VS Code version requirement from 1.108 to 1.90

## [1.1.0]
- Add trace_folder command
- Rename build_and_analyze command to trace_file
- Minor fixes (intial zoom and resizing)

## [1.0.3]

- Support absolute paths for the compilation database (directory or file)
- Improved error reporting when the compilation database is missing or invalid
- Add icon

## [1.0.2]

- Initial release