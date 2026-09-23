// PhotoSuite Download Manager
// Fetches latest release version from GitHub and generates download links

const GITHUB_REPO = 'eolix/photosuite';
const GITHUB_API = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;

// OS configuration with icons and file patterns
const OS_CONFIG = [
    {
        name: 'macOS',
        icon: 'images/macos.png',
        filePattern: /PhotoSuite_([0-9.]+)_universal\.dmg/,
        downloadUrl: (version) => `https://github.com/${GITHUB_REPO}/releases/download/v${version}/PhotoSuite_${version}_universal.dmg`
    },
    {
        name: 'Windows',
        icon: 'images/windows.png',
        filePattern: /PhotoSuite_([0-9.]+)_x64-setup\.exe/,
        downloadUrl: (version) => `https://github.com/${GITHUB_REPO}/releases/download/v${version}/PhotoSuite_${version}_x64-setup.exe`
    },
    {
        name: 'Debian / Ubuntu',
        icon: 'images/debian.png',
        filePattern: /PhotoSuite_([0-9.]+)_amd64\.deb/,
        downloadUrl: (version) => `https://github.com/${GITHUB_REPO}/releases/download/v${version}/PhotoSuite_${version}_amd64.deb`
    },
    {
        name: 'Fedora / RHEL',
        icon: 'images/fedora.png',
        filePattern: /PhotoSuite-([0-9.]+)-1\.x86_64\.rpm/,
        downloadUrl: (version) => `https://github.com/${GITHUB_REPO}/releases/download/v${version}/PhotoSuite-${version}-1.x86_64.rpm`
    }
];

/**
 * Extract version from filename using pattern
 */
function extractVersionFromFilename(filename, pattern) {
    const match = filename.match(pattern);
    return match ? match[1] : null;
}

/**
 * Extract version from assets directly
 */
async function extractVersionFromAssets() {
    try {
        const response = await fetch(GITHUB_API);
        const data = await response.json();
        
        // Check tag_name first
        if (data.tag_name) {
            return data.tag_name.startsWith('v') ? data.tag_name.substring(1) : data.tag_name;
        }
        
        // Try to extract from assets
        const assets = data.assets || [];
        
        for (const asset of assets) {
            const filename = asset.name;
            
            // Try each pattern
            for (const config of OS_CONFIG) {
                const version = extractVersionFromFilename(filename, config.filePattern);
                if (version) {
                    return version;
                }
            }
        }
        
        return null;
    } catch (error) {
        console.error('Error in extractVersionFromAssets:', error);
        return null;
    }
}

/**
 * Build download card HTML
 */
function createDownloadCard(osConfig, version) {
    const downloadUrl = osConfig.downloadUrl(version);
    
    return `
        <div class="download-card">
            <img src="${osConfig.icon}" alt="${osConfig.name}" class="os-icon">
            <h3>${osConfig.name}</h3>
            <p class="version">Version ${version}</p>
            <a href="${downloadUrl}" class="download-btn" download>Download</a>
        </div>
    `;
}

/**
 * Update downloads section with version info
 */
async function updateDownloads() {
    const downloadsContainer = document.getElementById('downloads');
    
    if (!downloadsContainer) {
        console.error('Downloads container not found');
        return;
    }
    
    // Show loading state
    downloadsContainer.innerHTML = '<p class="loading">Loading latest version...</p>';
    
    try {
        // Fetch the latest version
        let version = await extractVersionFromAssets();
        
        if (!version) {
            throw new Error('Could not determine version');
        }
        
        // Create download cards for each OS (in the order defined in OS_CONFIG)
        const cards = OS_CONFIG.map(config => createDownloadCard(config, version)).join('');
        
        downloadsContainer.innerHTML = cards;
        
    } catch (error) {
        console.error('Error updating downloads:', error);
        downloadsContainer.innerHTML = `
            <p class="loading" style="color: #ff6b6b;">
                Error loading version. Please refresh or check 
                <a href="https://github.com/${GITHUB_REPO}/releases" style="color: #04d7fd;">GitHub Releases</a>.
            </p>
        `;
    }
}

// Initialize when DOM is loaded
document.addEventListener('DOMContentLoaded', updateDownloads);

// Also try to load immediately in case DOMContentLoaded fires before script loads
if (document.readyState !== 'loading') {
    updateDownloads();
}
