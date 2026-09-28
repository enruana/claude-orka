import { Component, type ErrorInfo, type ReactNode, useEffect, useRef, useMemo, useState } from 'react'
import * as THREE from 'three'

interface ParticleCloudProps {
  state: 'idle' | 'listening' | 'thinking' | 'speaking' | 'connecting' | 'error'
  intensity?: number
}

// Vertex shader: positions particles, animates them with noise + time
const VERTEX_SHADER = `
  uniform float uTime;
  uniform float uIntensity;

  varying vec3 vColor;
  varying float vAlpha;

  // Simple value noise function
  float hash(vec3 p) {
    return fract(sin(dot(p, vec3(12.9898, 78.233, 45.164))) * 43758.5453);
  }

  float noise(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);

    float n = mix(
      mix(mix(hash(i), hash(i + vec3(1.0, 0.0, 0.0)), f.x),
          mix(hash(i + vec3(0.0, 1.0, 0.0)), hash(i + vec3(1.0, 1.0, 0.0)), f.x), f.y),
      mix(mix(hash(i + vec3(0.0, 0.0, 1.0)), hash(i + vec3(1.0, 0.0, 1.0)), f.x),
          mix(hash(i + vec3(0.0, 1.0, 1.0)), hash(i + vec3(1.0, 1.0, 1.0)), f.x), f.y), f.z
    );
    return n;
  }

  void main() {
    vec3 pos = position;

    // Multi-octave noise for organic movement
    float n1 = noise(vec3(pos.x * 0.5 + uTime * 0.3, pos.y * 0.5 + uTime * 0.2, uTime * 0.1));
    float n2 = noise(vec3(pos.z * 0.3 - uTime * 0.1, pos.x * 0.7 + uTime * 0.15, uTime * 0.05));
    float n3 = noise(vec3(pos.y * 0.4 + uTime * 0.25, pos.z * 0.6, uTime * 0.08));

    float noiseVal = n1 * 0.5 + n2 * 0.25 + n3 * 0.125;

    pos += normalize(position) * (noiseVal - 0.5) * uIntensity * 0.8;

    float pulse = sin(uTime * 2.0 + length(position)) * 0.1 * uIntensity;
    pos *= (1.0 + pulse);

    gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
    gl_PointSize = 5.0;

    float colorNoise = noise(vec3(position.xy * 0.2, 0.0));
    vColor = mix(
      vec3(0.3, 0.7, 1.0),
      vec3(0.6, 0.9, 1.0),
      colorNoise
    );

    float alphaNoise = noise(vec3(position.z * 0.3, 0.0, 0.0));
    vAlpha = mix(0.5, 1.0, alphaNoise);
    vAlpha *= (0.6 + sin(uTime * 3.0) * 0.4) * (0.7 + uIntensity);
  }
`

// Fragment shader: smooth particle rendering with glow
const FRAGMENT_SHADER = `
  varying vec3 vColor;
  varying float vAlpha;

  void main() {
    // Soft circle falloff
    vec2 centeredUV = (gl_PointCoord - 0.5) * 2.0;
    float dist = length(centeredUV);

    if (dist > 1.0) discard;

    // Gaussian falloff for soft glow - more intense
    float falloff = exp(-dist * dist * 2.0);

    gl_FragColor = vec4(vColor * 1.2, vAlpha * falloff);
  }
`

// Probe first: WebGLRenderer's constructor has side effects before it
// discovers the context request failed, so try/catch there leaves it
// half-initialized.
function isWebGLAvailable(): boolean {
  if (typeof window === 'undefined') return false
  if (!window.WebGLRenderingContext) return false
  try {
    const canvas = document.createElement('canvas')
    const gl =
      canvas.getContext('webgl2')
      || canvas.getContext('webgl')
      || canvas.getContext('experimental-webgl')
    return !!gl
  } catch {
    return false
  }
}

function ParticleCloudInner({ state, intensity: baseIntensity = 1.0 }: ParticleCloudProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const sceneRef = useRef<THREE.Scene | null>(null)
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null)
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null)
  const particlesRef = useRef<THREE.Points | null>(null)
  const intensityRef = useRef(baseIntensity)
  const animationFrameRef = useRef<number | null>(null)
  const [webglFailed, setWebglFailed] = useState(false)

  const getIntensityForState = (st: typeof state): number => {
    switch (st) {
      case 'idle': return 0.3
      case 'listening': return 0.6
      case 'thinking': return 1.0
      case 'speaking': return 0.8
      case 'connecting': return 0.5
      case 'error': return 0.2
      default: return 0.3
    }
  }

  useEffect(() => {
    if (!containerRef.current) return
    if (!isWebGLAvailable()) {
      setWebglFailed(true)
      return
    }

    const scene = new THREE.Scene()
    sceneRef.current = scene

    const width = containerRef.current.clientWidth
    const height = containerRef.current.clientHeight

    const camera = new THREE.PerspectiveCamera(75, width / height, 0.1, 1000)
    camera.position.z = 3
    cameraRef.current = camera

    let renderer: THREE.WebGLRenderer
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
    } catch (err) {
      console.warn('[ParticleCloud] WebGL renderer construction failed, falling back to CSS:', err)
      setWebglFailed(true)
      return
    }
    renderer.setSize(width, height)
    renderer.setClearColor(0x000000, 0)
    renderer.setPixelRatio(window.devicePixelRatio)
    containerRef.current.appendChild(renderer.domElement)
    rendererRef.current = renderer

    const particleCount = 2000
    const geometry = new THREE.BufferGeometry()
    const positions = new Float32Array(particleCount * 3)

    for (let i = 0; i < particleCount; i++) {
      const i3 = i * 3
      const theta = Math.random() * Math.PI * 2
      const phi = Math.acos(Math.random() * 2 - 1)
      const radius = 1.5 + Math.random() * 1.0

      positions[i3] = radius * Math.sin(phi) * Math.cos(theta)
      positions[i3 + 1] = radius * Math.sin(phi) * Math.sin(theta)
      positions[i3 + 2] = radius * Math.cos(phi)
    }

    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))

    const material = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uIntensity: { value: getIntensityForState(state) },
      },
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    })

    const particles = new THREE.Points(geometry, material)
    scene.add(particles)
    particlesRef.current = particles

    // Animation loop
    let startTime = Date.now()
    const animate = () => {
      animationFrameRef.current = requestAnimationFrame(animate)

      const elapsed = (Date.now() - startTime) / 1000
      material.uniforms.uTime.value = elapsed
      material.uniforms.uIntensity.value = intensityRef.current

      particles.rotation.x += 0.0001
      particles.rotation.y += 0.0003

      renderer.render(scene, camera)
    }
    animate()

    // Handle resize
    const handleResize = () => {
      if (!containerRef.current) return
      const w = containerRef.current.clientWidth
      const h = containerRef.current.clientHeight
      camera.aspect = w / h
      camera.updateProjectionMatrix()
      renderer.setSize(w, h)
    }

    window.addEventListener('resize', handleResize)

    return () => {
      window.removeEventListener('resize', handleResize)
      if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current)
      if (containerRef.current && renderer.domElement.parentElement === containerRef.current) {
        containerRef.current.removeChild(renderer.domElement)
      }
      geometry.dispose()
      material.dispose()
      renderer.dispose()
    }
  }, [])

  useEffect(() => {
    const targetIntensity = getIntensityForState(state)
    intensityRef.current += (targetIntensity - intensityRef.current) * 0.1
  }, [state])

  return (
    <div
      ref={containerRef}
      className={webglFailed ? `particle-cloud-fallback state-${state}` : undefined}
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width: '100%',
        height: '100%',
        zIndex: 0,
      }}
    />
  )
}

class ParticleCloudBoundary extends Component<
  { state: ParticleCloudProps['state']; children: ReactNode },
  { crashed: boolean }
> {
  state = { crashed: false }
  static getDerivedStateFromError(): { crashed: boolean } {
    return { crashed: true }
  }
  componentDidCatch(err: Error, info: ErrorInfo) {
    console.warn('[ParticleCloud] runtime error caught by boundary:', err, info)
  }
  render() {
    if (this.state.crashed) {
      return (
        <div
          className={`particle-cloud-fallback state-${this.props.state}`}
          style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', zIndex: 0 }}
        />
      )
    }
    return this.props.children
  }
}

export function ParticleCloud(props: ParticleCloudProps) {
  return (
    <ParticleCloudBoundary state={props.state}>
      <ParticleCloudInner {...props} />
    </ParticleCloudBoundary>
  )
}
