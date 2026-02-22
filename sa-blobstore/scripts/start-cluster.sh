#!/bin/bash

# SA-BLOBSTORE Cluster Startup Script
# Starts a 3-node distributed blob storage cluster

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Default configuration
DEFAULT_MIN_REPLICAS=1
DEFAULT_MAX_REPLICAS=2
DEFAULT_DATA_MOUNT="local"
DEFAULT_DATA_PATH="./data"

print_help() {
    cat << EOF
SA-BLOBSTORE Cluster Management Script

USAGE:
    $0 [OPTIONS]

OPTIONS:
    -r, --min-replicas NUM    Minimum replicas (default: $DEFAULT_MIN_REPLICAS)
    -R, --max-replicas NUM    Maximum replicas (default: $DEFAULT_MAX_REPLICAS)
    -d, --data-path PATH      Local data path (default: $DEFAULT_DATA_PATH)
    -m, --mount-type TYPE     Mount type: local|docker (default: $DEFAULT_DATA_MOUNT)
    -p, --ports PORT_RANGE    Port range for nodes (default: 8081-8083)
    -v, --verbose             Verbose output
    -h, --help               Show this help

EXAMPLES:
    # Start cluster with default settings (1 replica minimum, 2 maximum)
    $0

    # Start cluster with no replication (testing mode)
    $0 --min-replicas 0 --max-replicas 0

    # Start cluster with high availability (2 minimum, 3 maximum replicas)
    $0 --min-replicas 2 --max-replicas 3

    # Use Docker volumes instead of local bind mounts
    $0 --mount-type docker

    # Custom data path
    $0 --data-path /var/lib/blobstore

CLUSTER ACCESS:
    Load Balancer:  http://localhost:8080
    Node 1:         http://localhost:8081
    Node 2:         http://localhost:8082  
    Node 3:         http://localhost:8083
    Health Check:   http://localhost:8080/health

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

# Parse command line arguments
MIN_REPLICAS=$DEFAULT_MIN_REPLICAS
MAX_REPLICAS=$DEFAULT_MAX_REPLICAS
DATA_MOUNT_TYPE=$DEFAULT_DATA_MOUNT
DATA_PATH=$DEFAULT_DATA_PATH
VERBOSE=false
NODE1_PORT=8081
NODE2_PORT=8082
NODE3_PORT=8083

while [[ $# -gt 0 ]]; do
    case $1 in
        -r|--min-replicas)
            MIN_REPLICAS="$2"
            shift 2
            ;;
        -R|--max-replicas)
            MAX_REPLICAS="$2"
            shift 2
            ;;
        -d|--data-path)
            DATA_PATH="$2"
            shift 2
            ;;
        -m|--mount-type)
            DATA_MOUNT_TYPE="$2"
            shift 2
            ;;
        -p|--ports)
            IFS='-' read -ra PORTS <<< "$2"
            NODE1_PORT="${PORTS[0]}"
            NODE2_PORT="${PORTS[1]}"
            NODE3_PORT="${PORTS[2]}"
            shift 2
            ;;
        -v|--verbose)
            VERBOSE=true
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

# Validate arguments
if [[ ! "$MIN_REPLICAS" =~ ^[0-9]+$ ]] || [[ ! "$MAX_REPLICAS" =~ ^[0-9]+$ ]]; then
    error "Replica counts must be numbers"
    exit 1
fi

if [[ $MIN_REPLICAS -gt $MAX_REPLICAS ]]; then
    error "Minimum replicas ($MIN_REPLICAS) cannot be greater than maximum replicas ($MAX_REPLICAS)"
    exit 1
fi

if [[ "$DATA_MOUNT_TYPE" != "local" && "$DATA_MOUNT_TYPE" != "docker" ]]; then
    error "Mount type must be 'local' or 'docker'"
    exit 1
fi

# Change to project root
cd "$PROJECT_ROOT"

log "Starting SA-BLOBSTORE 3-Node Cluster"
log "Configuration:"
log "  Min Replicas: $MIN_REPLICAS"
log "  Max Replicas: $MAX_REPLICAS"
log "  Data Mount:   $DATA_MOUNT_TYPE"
log "  Data Path:    $DATA_PATH"
log "  Node Ports:   $NODE1_PORT, $NODE2_PORT, $NODE3_PORT"

# Create local data directories if using local mounts
if [[ "$DATA_MOUNT_TYPE" == "local" ]]; then
    log "Creating local data directories..."
    mkdir -p "$DATA_PATH"/{node1,node2,node3}
    chmod 755 "$DATA_PATH"/{node1,node2,node3}
    success "Local data directories created"
fi

# Create logs directory
log "Creating logs directory..."
mkdir -p logs/{node1,node2,node3}
chmod 755 logs/{node1,node2,node3}

# Check if .env file exists, create from example if not
if [[ ! -f .env ]]; then
    log "Creating .env file from template..."
    cp .env.example .env
fi

# Export environment variables
export MIN_REPLICAS
export MAX_REPLICAS
export DATA_MOUNT_TYPE
export DATA_PATH
export NODE1_PORT
export NODE2_PORT  
export NODE3_PORT

# Build and start the cluster
log "Building Docker images..."
if [[ "$VERBOSE" == "true" ]]; then
    docker-compose build --no-cache
else
    docker-compose build --no-cache >/dev/null 2>&1
fi

log "Starting cluster..."
if [[ "$VERBOSE" == "true" ]]; then
    docker-compose up -d
else
    docker-compose up -d >/dev/null 2>&1
fi

# Wait for services to be healthy
log "Waiting for services to start..."
sleep 10

# Check service health
check_health() {
    local node_name=$1
    local port=$2
    
    if curl -sf http://localhost:$port/actuator/health >/dev/null 2>&1; then
        success "$node_name is healthy"
        return 0
    else
        warn "$node_name is not ready yet"
        return 1
    fi
}

# Wait for all nodes to be healthy
max_attempts=30
attempt=0

while [[ $attempt -lt $max_attempts ]]; do
    healthy_nodes=0
    
    if check_health "Node 1" $NODE1_PORT; then
        ((healthy_nodes++))
    fi
    
    if check_health "Node 2" $NODE2_PORT; then
        ((healthy_nodes++))
    fi
    
    if check_health "Node 3" $NODE3_PORT; then
        ((healthy_nodes++))
    fi
    
    if [[ $healthy_nodes -eq 3 ]]; then
        success "All nodes are healthy!"
        break
    fi
    
    ((attempt++))
    if [[ $attempt -lt $max_attempts ]]; then
        log "Waiting for nodes to be ready... ($attempt/$max_attempts)"
        sleep 2
    fi
done

if [[ $attempt -eq $max_attempts ]]; then
    warn "Some nodes may not be fully ready yet. Check logs with: docker-compose logs"
fi

# Show cluster status
log "Cluster Status:"
docker-compose ps

log ""
success "SA-BLOBSTORE Cluster Started Successfully!"
log ""
log "Access Points:"
log "  Load Balancer:  http://localhost:8080"
log "  Node 1:         http://localhost:$NODE1_PORT"
log "  Node 2:         http://localhost:$NODE2_PORT"  
log "  Node 3:         http://localhost:$NODE3_PORT"
log "  Health Check:   http://localhost:8080/health"
log ""
log "Management Commands:"
log "  Stop cluster:   docker-compose down"
log "  View logs:      docker-compose logs -f"
log "  Scale services: docker-compose up -d --scale node1=2"
log "  Monitor:        ./scripts/monitor-cluster.sh"
log ""

# Create monitoring alias
log "Run './scripts/monitor-cluster.sh' to monitor cluster health"