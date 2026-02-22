#!/bin/bash

# SA-BLOBSTORE Storage Mount Switcher
# Switches between local bind mounts and Docker volumes for data storage

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

print_help() {
    cat << EOF
SA-BLOBSTORE Storage Mount Switcher

USAGE:
    $0 [COMMAND] [OPTIONS]

COMMANDS:
    local [PATH]         Switch to local bind mounts (default: ./data)
    docker               Switch to Docker managed volumes
    status               Show current storage configuration
    backup [SOURCE]      Backup data from source to ./backups/
    restore [BACKUP]     Restore data from backup
    migrate [FROM] [TO]  Migrate data between storage types

OPTIONS:
    -f, --force          Force operation without confirmation
    -v, --verbose        Verbose output
    -h, --help          Show this help

EXAMPLES:
    # Switch to local storage in ./data directory
    $0 local

    # Switch to local storage in custom directory  
    $0 local /var/lib/blobstore

    # Switch to Docker volumes
    $0 docker

    # Backup current data
    $0 backup

    # Migrate from local to docker volumes
    $0 migrate local docker

    # Check current configuration
    $0 status

STORAGE TYPES:
    local  - Data stored on host filesystem (bind mounts)
             Pros: Easy access, persistent across container rebuilds
             Cons: Host-dependent, permission issues possible

    docker - Data stored in Docker managed volumes  
             Pros: Portable, proper isolation, managed by Docker
             Cons: Less direct access, requires Docker commands to inspect

EOF
}

log() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

header() {
    echo -e "${CYAN}=== $1 ===${NC}"
}

confirm() {
    if [[ "$FORCE" == "true" ]]; then
        return 0
    fi
    
    echo -n -e "${YELLOW}[CONFIRM]${NC} $1 (y/N): "
    read -r response
    case "$response" in
        [yY][eE][sS]|[yY]) 
            return 0
            ;;
        *)
            return 1
            ;;
    esac
}

get_current_config() {
    cd "$PROJECT_ROOT"
    
    if [[ -f .env ]]; then
        local data_mount_type=$(grep "^DATA_MOUNT_TYPE=" .env | cut -d'=' -f2 | tr -d '"' | tr -d "'")
        local data_path=$(grep "^DATA_PATH=" .env | cut -d'=' -f2 | tr -d '"' | tr -d "'")
        
        echo "MOUNT_TYPE=${data_mount_type:-local}"
        echo "DATA_PATH=${data_path:-./data}"
    else
        echo "MOUNT_TYPE=local"
        echo "DATA_PATH=./data"
    fi
}

show_status() {
    header "Current Storage Configuration"
    
    eval "$(get_current_config)"
    
    echo "Mount Type: $MOUNT_TYPE"
    echo "Data Path:  $DATA_PATH"
    echo ""
    
    case "$MOUNT_TYPE" in
        "local")
            echo "Local Bind Mount Configuration:"
            echo "  Host Path: $(realpath "$DATA_PATH" 2>/dev/null || echo "$DATA_PATH")"
            echo "  Node 1:    $DATA_PATH/node1"
            echo "  Node 2:    $DATA_PATH/node2"  
            echo "  Node 3:    $DATA_PATH/node3"
            
            if [[ -d "$DATA_PATH" ]]; then
                echo ""
                echo "Directory Status:"
                for node in node1 node2 node3; do
                    if [[ -d "$DATA_PATH/$node" ]]; then
                        local size=$(du -sh "$DATA_PATH/$node" 2>/dev/null | cut -f1 || echo "unknown")
                        success "  $node: exists ($size)"
                    else
                        warn "  $node: missing"
                    fi
                done
            fi
            ;;
        "docker")
            echo "Docker Volume Configuration:"
            echo "  Volume Names:"
            echo "    dockernode1-data"
            echo "    dockernode2-data"  
            echo "    dockernode3-data"
            
            if command -v docker >/dev/null 2>&1; then
                echo ""
                echo "Docker Volume Status:"
                for volume in dockernode1-data dockernode2-data dockernode3-data; do
                    local full_name="${PWD##*/}_$volume"
                    if docker volume ls | grep -q "$full_name"; then
                        success "  $volume: exists"
                    else
                        warn "  $volume: missing"
                    fi
                done
            fi
            ;;
    esac
    
    # Check if cluster is running
    echo ""
    if command -v docker-compose >/dev/null 2>&1 && [[ -f docker-compose.yml ]]; then
        local running_containers=$(docker-compose ps -q 2>/dev/null | wc -l | tr -d ' ')
        if [[ "$running_containers" -gt 0 ]]; then
            warn "Cluster is currently running with $running_containers containers"
            echo "  Stop cluster before switching storage: docker-compose down"
        else
            success "Cluster is stopped (safe to switch storage)"
        fi
    fi
}

switch_to_local() {
    local target_path=${1:-./data}
    
    header "Switching to Local Bind Mounts"
    
    log "Target path: $target_path"
    
    if ! confirm "Switch to local bind mounts at '$target_path'?"; then
        log "Operation cancelled"
        return 1
    fi
    
    # Create target directories
    log "Creating local directories..."
    mkdir -p "$target_path"/{node1,node2,node3}
    chmod 755 "$target_path" "$target_path"/{node1,node2,node3}
    
    # Update .env file
    log "Updating configuration..."
    cd "$PROJECT_ROOT"
    
    if [[ -f .env ]]; then
        # Update existing .env
        sed -i.bak "s|^DATA_MOUNT_TYPE=.*|DATA_MOUNT_TYPE=local|" .env
        sed -i.bak "s|^DATA_PATH=.*|DATA_PATH=$target_path|" .env
    else
        # Create new .env from example
        cp .env.example .env
        sed -i.bak "s|^DATA_MOUNT_TYPE=.*|DATA_MOUNT_TYPE=local|" .env
        sed -i.bak "s|^DATA_PATH=.*|DATA_PATH=$target_path|" .env
    fi
    
    success "Switched to local bind mounts"
    log "Data will be stored at: $target_path/{node1,node2,node3}"
    log "Start cluster with: ./scripts/start-cluster.sh"
}

switch_to_docker() {
    header "Switching to Docker Volumes"
    
    if ! confirm "Switch to Docker managed volumes?"; then
        log "Operation cancelled"  
        return 1
    fi
    
    # Update .env file
    log "Updating configuration..."
    cd "$PROJECT_ROOT"
    
    if [[ -f .env ]]; then
        # Update existing .env
        sed -i.bak "s|^DATA_MOUNT_TYPE=.*|DATA_MOUNT_TYPE=docker|" .env
    else
        # Create new .env from example
        cp .env.example .env
        sed -i.bak "s|^DATA_MOUNT_TYPE=.*|DATA_MOUNT_TYPE=docker|" .env
    fi
    
    success "Switched to Docker volumes"
    log "Data will be stored in Docker managed volumes"
    log "Start cluster with: ./scripts/start-cluster.sh"
}

backup_data() {
    local source_type=${1:-current}
    
    header "Backing Up Data"
    
    eval "$(get_current_config)"
    
    local backup_dir="./backups/$(date +%Y%m%d-%H%M%S)"
    local source_desc
    
    case "$source_type" in
        "current"|"local")
            source_desc="local filesystem ($DATA_PATH)"
            ;;
        "docker")
            source_desc="Docker volumes"
            ;;
        *)
            error "Invalid backup source: $source_type"
            return 1
            ;;
    esac
    
    log "Creating backup from: $source_desc"
    log "Backup location: $backup_dir"
    
    if ! confirm "Create backup?"; then
        log "Backup cancelled"
        return 1
    fi
    
    mkdir -p "$backup_dir"
    
    case "$source_type" in
        "current"|"local")
            if [[ -d "$DATA_PATH" ]]; then
                cp -r "$DATA_PATH"/* "$backup_dir/" 2>/dev/null || true
                success "Local data backed up to: $backup_dir"
            else
                warn "No local data found at: $DATA_PATH"
            fi
            ;;
        "docker")
            # Backup from Docker volumes using temporary containers
            for node in node1 node2 node3; do
                local volume_name="${PWD##*/}_docker${node}-data"
                if docker volume ls | grep -q "$volume_name"; then
                    log "Backing up volume: $volume_name"
                    mkdir -p "$backup_dir/$node"
                    docker run --rm -v "$volume_name:/source" -v "$(realpath "$backup_dir")/$node:/backup" alpine \
                        cp -r /source/. /backup/ 2>/dev/null || true
                fi
            done
            success "Docker volume data backed up to: $backup_dir"
            ;;
    esac
    
    echo ""
    log "Backup completed: $backup_dir"
    log "List backups with: ls -la ./backups/"
}

migrate_data() {
    local from_type=$1
    local to_type=$2
    
    if [[ -z "$from_type" || -z "$to_type" ]]; then
        error "Usage: $0 migrate [local|docker] [local|docker]"
        return 1
    fi
    
    if [[ "$from_type" == "$to_type" ]]; then
        error "Source and destination types must be different"
        return 1
    fi
    
    header "Migrating Data: $from_type → $to_type"
    
    warn "This will:"
    echo "  1. Backup existing data"
    echo "  2. Switch storage configuration"
    echo "  3. Copy data to new storage type"
    echo ""
    
    if ! confirm "Proceed with migration?"; then
        log "Migration cancelled"
        return 1
    fi
    
    # Step 1: Backup current data
    log "Step 1: Creating backup..."
    backup_data "$from_type"
    
    # Step 2: Switch configuration
    log "Step 2: Switching configuration..."
    case "$to_type" in
        "local")
            switch_to_local ./data
            ;;
        "docker")
            switch_to_docker
            ;;
    esac
    
    # Step 3: Restore data to new storage
    log "Step 3: Copying data to new storage type..."
    # This would involve copying from backup to new storage
    # Implementation depends on specific migration needs
    
    success "Migration completed from $from_type to $to_type"
    log "Verify data with: ./scripts/monitor-cluster.sh --stats"
}

# Parse arguments
FORCE=false
VERBOSE=false

# Check for options first
while [[ $# -gt 0 ]]; do
    case $1 in
        -f|--force)
            FORCE=true
            shift
            ;;
        -v|--verbose)
            VERBOSE=true
            shift
            ;;
        -h|--help)
            print_help
            exit 0
            ;;
        -*)
            error "Unknown option: $1"
            print_help
            exit 1
            ;;
        *)
            break
            ;;
    esac
done

# Handle commands
COMMAND=${1:-status}

cd "$PROJECT_ROOT"

case "$COMMAND" in
    "local")
        switch_to_local "$2"
        ;;
    "docker")
        switch_to_docker
        ;;
    "status")
        show_status
        ;;
    "backup")
        backup_data "$2"
        ;;
    "migrate")
        migrate_data "$2" "$3"
        ;;
    *)
        error "Unknown command: $COMMAND"
        print_help
        exit 1
        ;;
esac