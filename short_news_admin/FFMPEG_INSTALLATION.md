# FFmpeg Installation Guide

This project uses FFmpeg for video thumbnail extraction. Follow these instructions to install FFmpeg on your system.

## macOS

### Using Homebrew (Recommended)
```bash
brew install ffmpeg
```

### Using MacPorts
```bash
sudo port install ffmpeg
```

## Ubuntu/Debian
```bash
sudo apt update
sudo apt install ffmpeg
```

## CentOS/RHEL
```bash
sudo yum install epel-release
sudo yum install ffmpeg
```

## Windows

1. Download FFmpeg from the official website: https://ffmpeg.org/download.html
2. Extract the downloaded archive
3. Add the `bin` directory to your system PATH

## Verification

After installation, verify FFmpeg is properly installed by running:
```bash
ffmpeg -version
```

You should see output similar to:
```
ffmpeg version 4.4.2 Copyright (c) 2000-2021 the FFmpeg developers
...
```

## Troubleshooting

If you encounter issues with FFmpeg not being found, you may need to set the FFmpeg path explicitly in your code:

```javascript
const ffmpeg = require('fluent-ffmpeg');
ffmpeg.setFfmpegPath('/path/to/ffmpeg');
```

The path varies by system:
- macOS (Homebrew): `/usr/local/bin/ffmpeg` or `/opt/homebrew/bin/ffmpeg`
- Ubuntu/Debian: `/usr/bin/ffmpeg`
- Windows: `C:\ffmpeg\bin\ffmpeg.exe`