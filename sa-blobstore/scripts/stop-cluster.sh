#!/bin/bash

# SA-BLOBSTORE Cluster Stop Script
# Gracefully stops the 3-node distributed blob storage cluster

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

print_help() {
    cat << EOF
SA-BLOBSTORE Cluster Stop Script

USAGE:
    $0 [OPTIONS]

OPTIONS:
    -f, --force          Force stop (docker-compose kill)
    -r, --remove         Remove containers after stopping
    -v, --volumes        Also remove volumes (WARNING: data loss!)
    -h, --help          Show this help

EXAMPLES:
    # Graceful stop
    $0

    # Force stop all containers
    $0 --force

    # Stop and remove containers
    $0 --remove

    # Stop, remove containers and volumes (DANGER!)
    $0 --remove --volumes

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

confirm() {
    if [[ "$FORCE_CONFIRM" == "true" ]]; then
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

# Parse command line arguments
FORCE_STOP=false
REMOVE_CONTAINERS=false
REMOVE_VOLUMES=false
FORCE_CONFIRM=false

while [[ $# -gt 0 ]]; do
    case $1 in
        -f|--force)
            FORCE_STOP=true
            shift
            ;;
        -r|--remove)
            REMOVE_CONTAINERS=true
            shift
            ;;
        -v|--volumes)
            REMOVE_VOLUMES=true
            shift
            ;;
        -y|--yes)
            FORCE_CONFIRM=true
            shift
            ;;
        -h|--help)
            print_help
            exit 0
            ;;
        *)
            error "Unknown option: $1"
            print_help
            exit 1
            ;;
    esac
done

# Change to project root
cd "$PROJECT_ROOT"

# Check if docker-compose.yml exists
if [[ ! -f docker-compose.yml ]]; then
    error "docker-compose.yml not found in current directory"
    exit 1
fi

# Check if any containers are running
running_containers=$(docker-compose ps -q 2>/dev/null | wc -l | tr -d ' ')

if [[ "$running_containers" -eq 0 ]]; then
    success "No containers are currently running"
    exit 0
fi

log "Found $running_containers running container(s)"

# Show current status
log "Current cluster status:"
docker-compose ps

# Confirm dangerous operations
if [[ "$REMOVE_VOLUMES" == "true" ]]; then
    warn "WARNING: This will permanently delete all blob data!"
    if ! confirm "Are you absolutely sure you want to remove volumes?"; then
        log "Operation cancelled"
        exit 1
    fi
fi

# Stop containers
if [[ "$FORCE_STOP" == "true" ]]; then
    log "Force stopping cluster..."
    docker-compose kill
else
    log "Gracefully stopping cluster..."
    docker-compose down
fi

# Remove containers if requested
if [[ "$REMOVE_CONTAINERS" == "true" ]]; then
    log "Removing containers..."
    docker-compose rm -f
fi

# Remove volumes if requested (dangerous!)
if [[ "$REMOVE_VOLUMES" == "true" ]]; then
    warn "Removing volumes and ALL DATA..."
    
    # Remove named volumes
    docker-compose down -v
    
    # Also try to remove any volumes that might be left
    project_name=$(basename "$PROJECT_ROOT" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]//g')
    for volume in dockernode1-data dockernode2-data dockernode3-data localnode1-data localnode2-data localnode3-data; do
        full_volume_name="${project_name}_${volume}"
        if docker volume ls | grep -q "$full_volume_name"; then
            log "Removing volume: $full_volume_name"
            docker volume rm "$full_volume_name" 2>/dev/null || true
        fi
    done
    
    warn "All volumes and data have been removed!"
fi

# Final status
log "Final status:"
remaining_containers=$(docker-compose ps -q 2>/dev/null | wc -l | tr -d ' ')

if [[ "$remaining_containers" -eq 0 ]]; then
    success "SA-BLOBSTORE cluster stopped successfully"
else
    warn "$remaining_containers container(s) still running"
    docker-compose ps
fi

# Cleanup advice
echo ""
log "Cleanup commands:"
log "  Remove dangling images: docker image prune"
log "  Remove unused volumes:   docker volume prune"  
log "  Remove all unused:       docker system prune"

if [[ "$REMOVE_VOLUMES" != "true" && -d "./data" ]]; then
    log "  Local data preserved at: ./data/"
fi