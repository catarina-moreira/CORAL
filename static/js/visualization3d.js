/**
 * 3D Visualization - Three.js based 3D mask viewer
 * Includes Marching Cubes mesh generation and Phong shading
 */

// 3D state
let scene3D = null;
let camera3D = null;
let renderer3D = null;
let meshGroup3D = null;
let animationFrame3D = null;
let isAutoRotate = true;

// ==================== 3D Modal Functions ====================

function open3DModal() {
    const modal = document.getElementById('modal3D');
    modal.classList.add('visible');
    
    if (!scene3D) {
        init3DScene();
    }
    
    build3DMesh();
    animate3D();
}

function close3DModal() {
    const modal = document.getElementById('modal3D');
    modal.classList.remove('visible');
    
    if (animationFrame3D) {
        cancelAnimationFrame(animationFrame3D);
        animationFrame3D = null;
    }
}

function init3DScene() {
    const container = document.getElementById('canvas3D').parentElement;
    const canvas = document.getElementById('canvas3D');
    
    // Scene
    scene3D = new THREE.Scene();
    scene3D.background = new THREE.Color(0x0a0a15);
    
    // Camera
    const aspect = container.clientWidth / container.clientHeight;
    camera3D = new THREE.PerspectiveCamera(60, aspect, 0.1, 2000);
    camera3D.position.set(0, 0, 300);
    
    // Renderer
    renderer3D = new THREE.WebGLRenderer({ canvas: canvas, antialias: true });
    renderer3D.setSize(container.clientWidth, container.clientHeight);
    renderer3D.setPixelRatio(window.devicePixelRatio);
    
    // Lights - improved for Phong shading
    const ambientLight = new THREE.AmbientLight(0x404040, 0.4);
    scene3D.add(ambientLight);
    
    const directionalLight1 = new THREE.DirectionalLight(0xffffff, 0.8);
    directionalLight1.position.set(1, 1, 1);
    scene3D.add(directionalLight1);
    
    const directionalLight2 = new THREE.DirectionalLight(0x00d9ff, 0.4);
    directionalLight2.position.set(-1, -1, -1);
    scene3D.add(directionalLight2);
    
    const directionalLight3 = new THREE.DirectionalLight(0xffffff, 0.3);
    directionalLight3.position.set(0, 1, -1);
    scene3D.add(directionalLight3);
    
    const directionalLight4 = new THREE.DirectionalLight(0xffffcc, 0.2);
    directionalLight4.position.set(-1, 0, 1);
    scene3D.add(directionalLight4);
    
    // Simple orbit controls (manual implementation since OrbitControls not in core)
    setupOrbitControls(canvas);
    
    // Handle resize
    window.addEventListener('resize', onWindowResize3D);
}

function setupOrbitControls(canvas) {
    let isDragging = false;
    let isPanning = false;
    let previousMousePosition = { x: 0, y: 0 };
    let spherical = { theta: 0, phi: Math.PI / 2, radius: 300 };
    let target = new THREE.Vector3(0, 0, 0);
    
    canvas.addEventListener('mousedown', (e) => {
        if (e.button === 0) isDragging = true;
        if (e.button === 2) isPanning = true;
        previousMousePosition = { x: e.clientX, y: e.clientY };
    });
    
    canvas.addEventListener('mousemove', (e) => {
        const deltaX = e.clientX - previousMousePosition.x;
        const deltaY = e.clientY - previousMousePosition.y;
        
        if (isDragging) {
            spherical.theta -= deltaX * 0.01;
            spherical.phi -= deltaY * 0.01;
            spherical.phi = Math.max(0.1, Math.min(Math.PI - 0.1, spherical.phi));
            updateCameraPosition();
        }
        
        if (isPanning) {
            const panSpeed = 0.5;
            target.x -= deltaX * panSpeed;
            target.y += deltaY * panSpeed;
            updateCameraPosition();
        }
        
        previousMousePosition = { x: e.clientX, y: e.clientY };
    });
    
    canvas.addEventListener('mouseup', () => {
        isDragging = false;
        isPanning = false;
    });
    
    canvas.addEventListener('mouseleave', () => {
        isDragging = false;
        isPanning = false;
    });
    
    canvas.addEventListener('wheel', (e) => {
        e.preventDefault();
        spherical.radius += e.deltaY * 0.5;
        spherical.radius = Math.max(50, Math.min(1000, spherical.radius));
        updateCameraPosition();
    });
    
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    
    function updateCameraPosition() {
        camera3D.position.x = target.x + spherical.radius * Math.sin(spherical.phi) * Math.cos(spherical.theta);
        camera3D.position.y = target.y + spherical.radius * Math.cos(spherical.phi);
        camera3D.position.z = target.z + spherical.radius * Math.sin(spherical.phi) * Math.sin(spherical.theta);
        camera3D.lookAt(target);
    }
}

function onWindowResize3D() {
    if (!camera3D || !renderer3D) return;
    const container = document.getElementById('canvas3D').parentElement;
    camera3D.aspect = container.clientWidth / container.clientHeight;
    camera3D.updateProjectionMatrix();
    renderer3D.setSize(container.clientWidth, container.clientHeight);
}

function animate3D() {
    if (!document.getElementById('modal3D').classList.contains('visible')) return;
    animationFrame3D = requestAnimationFrame(animate3D);
    
    if (isAutoRotate && meshGroup3D) {
        meshGroup3D.rotation.y += 0.005;
    }
    
    if (renderer3D && scene3D && camera3D) {
        renderer3D.render(scene3D, camera3D);
    }
}

function build3DMesh() {
    // Remove existing meshes
    if (meshGroup3D) {
        scene3D.remove(meshGroup3D);
        meshGroup3D.traverse((child) => {
            if (child.geometry) child.geometry.dispose();
            if (child.material) child.material.dispose();
        });
    }
    
    meshGroup3D = new THREE.Group();
    
    if (!masks || !ctDims) {
        scene3D.add(meshGroup3D);
        updateMeshInfo(0, 0);
        return;
    }
    
    const renderMode = document.getElementById('view3DMode').value;
    let totalVerts = 0;
    let totalTris = 0;
    
    // Build mesh for each label
    for (const [label, color] of Object.entries(COLORS)) {
        const labelNum = parseInt(label);
        let mesh;
        
        if (renderMode === 'surface') {
            mesh = buildSurfaceVoxels(labelNum, parseInt(color.substr(1), 16));
        } else {
            mesh = buildMarchingCubesMesh(labelNum, parseInt(color.substr(1), 16));
        }
        
        if (mesh) {
            meshGroup3D.add(mesh);
            if (mesh.geometry) {
                totalVerts += mesh.geometry.attributes.position.count;
                if (mesh.geometry.index) {
                    totalTris += mesh.geometry.index.count / 3;
                }
            }
        }
    }
    
    scene3D.add(meshGroup3D);
    updateMeshInfo(totalVerts, totalTris);
}

function buildSurfaceVoxels(label, color) {
    const [width, height, depth] = ctDims;
    const sliceSize = width * height;
    
    // Find all surface voxels (voxels with at least one empty neighbor)
    const surfaceVoxels = [];
    const neighbors = [
        [-1, 0, 0], [1, 0, 0],
        [0, -1, 0], [0, 1, 0],
        [0, 0, -1], [0, 0, 1]
    ];
    
    for (let z = 0; z < depth; z++) {
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const idx = z * sliceSize + y * width + x;
                if (masks[idx] !== label) continue;
                
                // Check if surface voxel
                let isSurface = false;
                for (const [dx, dy, dz] of neighbors) {
                    const nx = x + dx, ny = y + dy, nz = z + dz;
                    if (nx < 0 || nx >= width || ny < 0 || ny >= height || nz < 0 || nz >= depth) {
                        isSurface = true;
                        break;
                    }
                    const nidx = nz * sliceSize + ny * width + nx;
                    if (masks[nidx] !== label) {
                        isSurface = true;
                        break;
                    }
                }
                
                if (isSurface) {
                    surfaceVoxels.push({ x, y, z });
                }
            }
        }
    }
    
    if (surfaceVoxels.length === 0) return null;
    
    // Create instanced boxes for surface voxels
    const boxSize = 1;
    const geometry = new THREE.BoxGeometry(boxSize, boxSize, boxSize);
    const material = new THREE.MeshPhongMaterial({
        color: color,
        specular: 0x222222,
        shininess: 20
    });
    
    const instancedMesh = new THREE.InstancedMesh(geometry, material, surfaceVoxels.length);
    const dummy = new THREE.Object3D();
    
    for (let i = 0; i < surfaceVoxels.length; i++) {
        const v = surfaceVoxels[i];
        dummy.position.set(
            v.x - width / 2,
            -(v.y - height / 2),
            v.z - depth / 2
        );
        dummy.updateMatrix();
        instancedMesh.setMatrixAt(i, dummy.matrix);
    }
    
    return instancedMesh;
}

function buildMarchingCubesMesh(label, color) {
    const [width, height, depth] = ctDims;
    const sliceSize = width * height;
    
    // Helper to check if voxel is set
    const isSet = (x, y, z) => {
        if (x < 0 || x >= width || y < 0 || y >= height || z < 0 || z >= depth) return false;
        return masks[z * sliceSize + y * width + x] === label;
    };
    
    // Interpolate between vertices
    const interp = (p1, p2) => {
        return [(p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2, (p1[2] + p2[2]) / 2];
    };
    
    const vertices = [];
    const indices = [];
    const vertexCache = new Map();
    
    const getVertexIndex = (v) => {
        const key = `${v[0].toFixed(2)},${v[1].toFixed(2)},${v[2].toFixed(2)}`;
        if (vertexCache.has(key)) return vertexCache.get(key);
        const idx = vertices.length / 3;
        vertices.push(v[0] - width/2, -(v[1] - height/2), v[2] - depth/2);
        vertexCache.set(key, idx);
        return idx;
    };
    
    // Edge table and triangle table for Marching Cubes
    const edgeTable = [0x0,0x109,0x203,0x30a,0x406,0x50f,0x605,0x70c,0x80c,0x905,0xa0f,0xb06,0xc0a,0xd03,0xe09,0xf00,0x190,0x99,0x393,0x29a,0x596,0x49f,0x795,0x69c,0x99c,0x895,0xb9f,0xa96,0xd9a,0xc93,0xf99,0xe90,0x230,0x339,0x33,0x13a,0x636,0x73f,0x435,0x53c,0xa3c,0xb35,0x83f,0x936,0xe3a,0xf33,0xc39,0xd30,0x3a0,0x2a9,0x1a3,0xaa,0x7a6,0x6af,0x5a5,0x4ac,0xbac,0xaa5,0x9af,0x8a6,0xfaa,0xea3,0xda9,0xca0,0x460,0x569,0x663,0x76a,0x66,0x16f,0x265,0x36c,0xc6c,0xd65,0xe6f,0xf66,0x86a,0x963,0xa69,0xb60,0x5f0,0x4f9,0x7f3,0x6fa,0x1f6,0xff,0x3f5,0x2fc,0xdfc,0xcf5,0xfff,0xef6,0x9fa,0x8f3,0xbf9,0xaf0,0x650,0x759,0x453,0x55a,0x256,0x35f,0x55,0x15c,0xe5c,0xf55,0xc5f,0xd56,0xa5a,0xb53,0x859,0x950,0x7c0,0x6c9,0x5c3,0x4ca,0x3c6,0x2cf,0x1c5,0xcc,0xfcc,0xec5,0xdcf,0xcc6,0xbca,0xac3,0x9c9,0x8c0,0x8c0,0x9c9,0xac3,0xbca,0xcc6,0xdcf,0xec5,0xfcc,0xcc,0x1c5,0x2cf,0x3c6,0x4ca,0x5c3,0x6c9,0x7c0,0x950,0x859,0xb53,0xa5a,0xd56,0xc5f,0xf55,0xe5c,0x15c,0x55,0x35f,0x256,0x55a,0x453,0x759,0x650,0xaf0,0xbf9,0x8f3,0x9fa,0xef6,0xfff,0xcf5,0xdfc,0x2fc,0x3f5,0xff,0x1f6,0x6fa,0x7f3,0x4f9,0x5f0,0xb60,0xa69,0x963,0x86a,0xf66,0xe6f,0xd65,0xc6c,0x36c,0x265,0x16f,0x66,0x76a,0x663,0x569,0x460,0xca0,0xda9,0xea3,0xfaa,0x8a6,0x9af,0xaa5,0xbac,0x4ac,0x5a5,0x6af,0x7a6,0xaa,0x1a3,0x2a9,0x3a0,0xd30,0xc39,0xf33,0xe3a,0x936,0x83f,0xb35,0xa3c,0x53c,0x435,0x73f,0x636,0x13a,0x33,0x339,0x230,0xe90,0xf99,0xc93,0xd9a,0xa96,0xb9f,0x895,0x99c,0x69c,0x795,0x49f,0x596,0x29a,0x393,0x99,0x190,0xf00,0xe09,0xd03,0xc0a,0xb06,0xa0f,0x905,0x80c,0x70c,0x605,0x50f,0x406,0x30a,0x203,0x109,0x0];
    
    const triTable = [[],[0,8,3],[0,1,9],[1,8,3,9,8,1],[1,2,10],[0,8,3,1,2,10],[9,2,10,0,2,9],[2,8,3,2,10,8,10,9,8],[3,11,2],[0,11,2,8,11,0],[1,9,0,2,3,11],[1,11,2,1,9,11,9,8,11],[3,10,1,11,10,3],[0,10,1,0,8,10,8,11,10],[3,9,0,3,11,9,11,10,9],[9,8,10,10,8,11],[4,7,8],[4,3,0,7,3,4],[0,1,9,8,4,7],[4,1,9,4,7,1,7,3,1],[1,2,10,8,4,7],[3,4,7,3,0,4,1,2,10],[9,2,10,9,0,2,8,4,7],[2,10,9,2,9,7,2,7,3,7,9,4],[8,4,7,3,11,2],[11,4,7,11,2,4,2,0,4],[9,0,1,8,4,7,2,3,11],[4,7,11,9,4,11,9,11,2,9,2,1],[3,10,1,3,11,10,7,8,4],[1,11,10,1,4,11,1,0,4,7,11,4],[4,7,8,9,0,11,9,11,10,11,0,3],[4,7,11,4,11,9,9,11,10],[9,5,4],[9,5,4,0,8,3],[0,5,4,1,5,0],[8,5,4,8,3,5,3,1,5],[1,2,10,9,5,4],[3,0,8,1,2,10,4,9,5],[5,2,10,5,4,2,4,0,2],[2,10,5,3,2,5,3,5,4,3,4,8],[9,5,4,2,3,11],[0,11,2,0,8,11,4,9,5],[0,5,4,0,1,5,2,3,11],[2,1,5,2,5,8,2,8,11,4,8,5],[10,3,11,10,1,3,9,5,4],[4,9,5,0,8,1,8,10,1,8,11,10],[5,4,0,5,0,11,5,11,10,11,0,3],[5,4,8,5,8,10,10,8,11],[9,7,8,5,7,9],[9,3,0,9,5,3,5,7,3],[0,7,8,0,1,7,1,5,7],[1,5,3,3,5,7],[9,7,8,9,5,7,10,1,2],[10,1,2,9,5,0,5,3,0,5,7,3],[8,0,2,8,2,5,8,5,7,10,5,2],[2,10,5,2,5,3,3,5,7],[7,9,5,7,8,9,3,11,2],[9,5,7,9,7,2,9,2,0,2,7,11],[2,3,11,0,1,8,1,7,8,1,5,7],[11,2,1,11,1,7,7,1,5],[9,5,8,8,5,7,10,1,3,10,3,11],[5,7,0,5,0,9,7,11,0,1,0,10,11,10,0],[11,10,0,11,0,3,10,5,0,8,0,7,5,7,0],[11,10,5,7,11,5],[10,6,5],[0,8,3,5,10,6],[9,0,1,5,10,6],[1,8,3,1,9,8,5,10,6],[1,6,5,2,6,1],[1,6,5,1,2,6,3,0,8],[9,6,5,9,0,6,0,2,6],[5,9,8,5,8,2,5,2,6,3,2,8],[2,3,11,10,6,5],[11,0,8,11,2,0,10,6,5],[0,1,9,2,3,11,5,10,6],[5,10,6,1,9,2,9,11,2,9,8,11],[6,3,11,6,5,3,5,1,3],[0,8,11,0,11,5,0,5,1,5,11,6],[3,11,6,0,3,6,0,6,5,0,5,9],[6,5,9,6,9,11,11,9,8],[5,10,6,4,7,8],[4,3,0,4,7,3,6,5,10],[1,9,0,5,10,6,8,4,7],[10,6,5,1,9,7,1,7,3,7,9,4],[6,1,2,6,5,1,4,7,8],[1,2,5,5,2,6,3,0,4,3,4,7],[8,4,7,9,0,5,0,6,5,0,2,6],[7,3,9,7,9,4,3,2,9,5,9,6,2,6,9],[3,11,2,7,8,4,10,6,5],[5,10,6,4,7,2,4,2,0,2,7,11],[0,1,9,4,7,8,2,3,11,5,10,6],[9,2,1,9,11,2,9,4,11,7,11,4,5,10,6],[8,4,7,3,11,5,3,5,1,5,11,6],[5,1,11,5,11,6,1,0,11,7,11,4,0,4,11],[0,5,9,0,6,5,0,3,6,11,6,3,8,4,7],[6,5,9,6,9,11,4,7,9,7,11,9],[10,4,9,6,4,10],[4,10,6,4,9,10,0,8,3],[10,0,1,10,6,0,6,4,0],[8,3,1,8,1,6,8,6,4,6,1,10],[1,4,9,1,2,4,2,6,4],[3,0,8,1,2,9,2,4,9,2,6,4],[0,2,4,4,2,6],[8,3,2,8,2,4,4,2,6],[10,4,9,10,6,4,11,2,3],[0,8,2,2,8,11,4,9,10,4,10,6],[3,11,2,0,1,6,0,6,4,6,1,10],[6,4,1,6,1,10,4,8,1,2,1,11,8,11,1],[9,6,4,9,3,6,9,1,3,11,6,3],[8,11,1,8,1,0,11,6,1,9,1,4,6,4,1],[3,11,6,3,6,0,0,6,4],[6,4,8,11,6,8],[7,10,6,7,8,10,8,9,10],[0,7,3,0,10,7,0,9,10,6,7,10],[10,6,7,1,10,7,1,7,8,1,8,0],[10,6,7,10,7,1,1,7,3],[1,2,6,1,6,8,1,8,9,8,6,7],[2,6,9,2,9,1,6,7,9,0,9,3,7,3,9],[7,8,0,7,0,6,6,0,2],[7,3,2,6,7,2],[2,3,11,10,6,8,10,8,9,8,6,7],[2,0,7,2,7,11,0,9,7,6,7,10,9,10,7],[1,8,0,1,7,8,1,10,7,6,7,10,2,3,11],[11,2,1,11,1,7,10,6,1,6,7,1],[8,9,6,8,6,7,9,1,6,11,6,3,1,3,6],[0,9,1,11,6,7],[7,8,0,7,0,6,3,11,0,11,6,0],[7,11,6],[7,6,11],[3,0,8,11,7,6],[0,1,9,11,7,6],[8,1,9,8,3,1,11,7,6],[10,1,2,6,11,7],[1,2,10,3,0,8,6,11,7],[2,9,0,2,10,9,6,11,7],[6,11,7,2,10,3,10,8,3,10,9,8],[7,2,3,6,2,7],[7,0,8,7,6,0,6,2,0],[2,7,6,2,3,7,0,1,9],[1,6,2,1,8,6,1,9,8,8,7,6],[10,7,6,10,1,7,1,3,7],[10,7,6,1,7,10,1,8,7,1,0,8],[0,3,7,0,7,10,0,10,9,6,10,7],[7,6,10,7,10,8,8,10,9],[6,8,4,11,8,6],[3,6,11,3,0,6,0,4,6],[8,6,11,8,4,6,9,0,1],[9,4,6,9,6,3,9,3,1,11,3,6],[6,8,4,6,11,8,2,10,1],[1,2,10,3,0,11,0,6,11,0,4,6],[4,11,8,4,6,11,0,2,9,2,10,9],[10,9,3,10,3,2,9,4,3,11,3,6,4,6,3],[8,2,3,8,4,2,4,6,2],[0,4,2,4,6,2],[1,9,0,2,3,4,2,4,6,4,3,8],[1,9,4,1,4,2,2,4,6],[8,1,3,8,6,1,8,4,6,6,10,1],[10,1,0,10,0,6,6,0,4],[4,6,3,4,3,8,6,10,3,0,3,9,10,9,3],[10,9,4,6,10,4],[4,9,5,7,6,11],[0,8,3,4,9,5,11,7,6],[5,0,1,5,4,0,7,6,11],[11,7,6,8,3,4,3,5,4,3,1,5],[9,5,4,10,1,2,7,6,11],[6,11,7,1,2,10,0,8,3,4,9,5],[7,6,11,5,4,10,4,2,10,4,0,2],[3,4,8,3,5,4,3,2,5,10,5,2,11,7,6],[7,2,3,7,6,2,5,4,9],[9,5,4,0,8,6,0,6,2,6,8,7],[3,6,2,3,7,6,1,5,0,5,4,0],[6,2,8,6,8,7,2,1,8,4,8,5,1,5,8],[9,5,4,10,1,6,1,7,6,1,3,7],[1,6,10,1,7,6,1,0,7,8,7,0,9,5,4],[4,0,10,4,10,5,0,3,10,6,10,7,3,7,10],[7,6,10,7,10,8,5,4,10,4,8,10],[6,9,5,6,11,9,11,8,9],[3,6,11,0,6,3,0,5,6,0,9,5],[0,11,8,0,5,11,0,1,5,5,6,11],[6,11,3,6,3,5,5,3,1],[1,2,10,9,5,11,9,11,8,11,5,6],[0,11,3,0,6,11,0,9,6,5,6,9,1,2,10],[11,8,5,11,5,6,8,0,5,10,5,2,0,2,5],[6,11,3,6,3,5,2,10,3,10,5,3],[5,8,9,5,2,8,5,6,2,3,8,2],[9,5,6,9,6,0,0,6,2],[1,5,8,1,8,0,5,6,8,3,8,2,6,2,8],[1,5,6,2,1,6],[1,3,6,1,6,10,3,8,6,5,6,9,8,9,6],[10,1,0,10,0,6,9,5,0,5,6,0],[0,3,8,5,6,10],[10,5,6],[11,5,10,7,5,11],[11,5,10,11,7,5,8,3,0],[5,11,7,5,10,11,1,9,0],[10,7,5,10,11,7,9,8,1,8,3,1],[11,1,2,11,7,1,7,5,1],[0,8,3,1,2,7,1,7,5,7,2,11],[9,7,5,9,2,7,9,0,2,2,11,7],[7,5,2,7,2,11,5,9,2,3,2,8,9,8,2],[2,5,10,2,3,5,3,7,5],[8,2,0,8,5,2,8,7,5,10,2,5],[9,0,1,5,10,3,5,3,7,3,10,2],[9,8,2,9,2,1,8,7,2,10,2,5,7,5,2],[1,3,5,3,7,5],[0,8,7,0,7,1,1,7,5],[9,0,3,9,3,5,5,3,7],[9,8,7,5,9,7],[5,8,4,5,10,8,10,11,8],[5,0,4,5,11,0,5,10,11,11,3,0],[0,1,9,8,4,10,8,10,11,10,4,5],[10,11,4,10,4,5,11,3,4,9,4,1,3,1,4],[2,5,1,2,8,5,2,11,8,4,5,8],[0,4,11,0,11,3,4,5,11,2,11,1,5,1,11],[0,2,5,0,5,9,2,11,5,4,5,8,11,8,5],[9,4,5,2,11,3],[2,5,10,3,5,2,3,4,5,3,8,4],[5,10,2,5,2,4,4,2,0],[3,10,2,3,5,10,3,8,5,4,5,8,0,1,9],[5,10,2,5,2,4,1,9,2,9,4,2],[8,4,5,8,5,3,3,5,1],[0,4,5,1,0,5],[8,4,5,8,5,3,9,0,5,0,3,5],[9,4,5],[4,11,7,4,9,11,9,10,11],[0,8,3,4,9,7,9,11,7,9,10,11],[1,10,11,1,11,4,1,4,0,7,4,11],[3,1,4,3,4,8,1,10,4,7,4,11,10,11,4],[4,11,7,9,11,4,9,2,11,9,1,2],[9,7,4,9,11,7,9,1,11,2,11,1,0,8,3],[11,7,4,11,4,2,2,4,0],[11,7,4,11,4,2,8,3,4,3,2,4],[2,9,10,2,7,9,2,3,7,7,4,9],[9,10,7,9,7,4,10,2,7,8,7,0,2,0,7],[3,7,10,3,10,2,7,4,10,1,10,0,4,0,10],[1,10,2,8,7,4],[4,9,1,4,1,7,7,1,3],[4,9,1,4,1,7,0,8,1,8,7,1],[4,0,3,7,4,3],[4,8,7],[9,10,8,10,11,8],[3,0,9,3,9,11,11,9,10],[0,1,10,0,10,8,8,10,11],[3,1,10,11,3,10],[1,2,11,1,11,9,9,11,8],[3,0,9,3,9,11,1,2,9,2,11,9],[0,2,11,8,0,11],[3,2,11],[2,3,8,2,8,10,10,8,9],[9,10,2,0,9,2],[2,3,8,2,8,10,0,1,8,1,10,8],[1,10,2],[1,3,8,9,1,8],[0,9,1],[0,3,8],[]];
    
    // Process each cube in volume
    for (let z = 0; z < depth - 1; z++) {
        for (let y = 0; y < height - 1; y++) {
            for (let x = 0; x < width - 1; x++) {
                const cubeIndex = 
                    (isSet(x, y, z) ? 1 : 0) |
                    (isSet(x+1, y, z) ? 2 : 0) |
                    (isSet(x+1, y+1, z) ? 4 : 0) |
                    (isSet(x, y+1, z) ? 8 : 0) |
                    (isSet(x, y, z+1) ? 16 : 0) |
                    (isSet(x+1, y, z+1) ? 32 : 0) |
                    (isSet(x+1, y+1, z+1) ? 64 : 0) |
                    (isSet(x, y+1, z+1) ? 128 : 0);
                
                if (edgeTable[cubeIndex] === 0) continue;
                
                const p = [[x,y,z],[x+1,y,z],[x+1,y+1,z],[x,y+1,z],[x,y,z+1],[x+1,y,z+1],[x+1,y+1,z+1],[x,y+1,z+1]];
                const ev = new Array(12);
                if (edgeTable[cubeIndex] & 1) ev[0] = interp(p[0], p[1]);
                if (edgeTable[cubeIndex] & 2) ev[1] = interp(p[1], p[2]);
                if (edgeTable[cubeIndex] & 4) ev[2] = interp(p[2], p[3]);
                if (edgeTable[cubeIndex] & 8) ev[3] = interp(p[3], p[0]);
                if (edgeTable[cubeIndex] & 16) ev[4] = interp(p[4], p[5]);
                if (edgeTable[cubeIndex] & 32) ev[5] = interp(p[5], p[6]);
                if (edgeTable[cubeIndex] & 64) ev[6] = interp(p[6], p[7]);
                if (edgeTable[cubeIndex] & 128) ev[7] = interp(p[7], p[4]);
                if (edgeTable[cubeIndex] & 256) ev[8] = interp(p[0], p[4]);
                if (edgeTable[cubeIndex] & 512) ev[9] = interp(p[1], p[5]);
                if (edgeTable[cubeIndex] & 1024) ev[10] = interp(p[2], p[6]);
                if (edgeTable[cubeIndex] & 2048) ev[11] = interp(p[3], p[7]);
                
                const tris = triTable[cubeIndex];
                for (let i = 0; i < tris.length; i += 3) {
                    indices.push(getVertexIndex(ev[tris[i]]), getVertexIndex(ev[tris[i+1]]), getVertexIndex(ev[tris[i+2]]));
                }
            }
        }
    }
    
    if (vertices.length === 0) return null;
    
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    
    const flatShading = document.getElementById('shadingMode3D').value === 'flat';
    const material = new THREE.MeshPhongMaterial({
        color: color,
        specular: 0x444444,
        shininess: 30,
        side: THREE.DoubleSide,
        flatShading: flatShading
    });
    
    return new THREE.Mesh(geometry, material);
}

function update3DView() {
    if (meshGroup3D) {
        const container = document.getElementById('canvas3D').parentElement;
        const existingMsg = container.querySelector('.building-msg');
        if (existingMsg) existingMsg.remove();
        
        const msg = document.createElement('div');
        msg.className = 'building-msg';
        msg.style.cssText = 'position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);color:#00d9ff;font-size:1.2em;z-index:10;background:rgba(0,0,0,0.7);padding:15px 25px;border-radius:8px;';
        msg.textContent = 'Rebuilding mesh...';
        container.appendChild(msg);
        
        setTimeout(() => {
            build3DMesh();
            msg.remove();
        }, 50);
    }
}

function updatePointSize() {
    if (!meshGroup3D) return;
    const size = parseInt(document.getElementById('pointSize3D').value);
    meshGroup3D.traverse((child) => {
        if (child.isMesh && child.isInstancedMesh) {
            // For instanced meshes, we'd need to rebuild
            // This is a simplification
        }
    });
}

function updateMeshInfo(verts, tris) {
    document.getElementById('meshInfo3D').textContent = 
        `Vertices: ${verts.toLocaleString()} | Triangles: ${tris.toLocaleString()}`;
}

function updateShading() {
    if (!meshGroup3D) return;
    const flatShading = document.getElementById('shadingMode3D').value === 'flat';
    meshGroup3D.traverse((child) => {
        if (child instanceof THREE.Mesh && child.material) {
            child.material.flatShading = flatShading;
            child.material.needsUpdate = true;
            // Recompute normals for flat shading
            if (child.geometry) {
                child.geometry.computeVertexNormals();
            }
        }
    });
}

function toggleAutoRotate() {
    isAutoRotate = document.getElementById('autoRotate3D').checked;
}

// Export functions globally
window.Visualization3D = {
    open3DModal,
    close3DModal,
    update3DView,
    updatePointSize,
    build3DMesh,
    animate3D,
    init3DScene,
    updateShading,
    toggleAutoRotate
};

// Also expose scene3D check
Object.defineProperty(window, 'scene3D', {
    get: function() { return scene3D; }
});
