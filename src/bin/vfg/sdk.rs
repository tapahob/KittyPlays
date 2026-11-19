use super::Result;
use libloading::os::windows::{
    Library, LOAD_LIBRARY_SEARCH_SYSTEM32, LOAD_WITH_ALTERED_SEARCH_PATH,
};
use std::ffi::{c_char, c_void, CStr};
use std::path::Path;
use std::ptr::{null_mut, NonNull};

type Handle = *mut c_void;
type Status = i32;
const RGBA: u32 = 6;
const U8: u32 = 1;
const INTERLEAVED: u32 = 0;
const CPU: u32 = 0;
const GPU: u32 = 1;

// ABI from NVIDIA's nvCVImage.h. Byte fields between component type and
// pixels describe layout, memory space, color space, and reserved padding.
#[repr(C)]
struct Image {
    width: u32,
    height: u32,
    pitch: i32,
    format: u32,
    component_type: u32,
    layout_fields: [u8; 8],
    pixels: Handle,
    delete_ptr: Handle,
    delete_proc: Option<unsafe extern "C" fn(Handle)>,
    buffer_bytes: u64,
}

pub struct Api {
    _vfx: Library,
    _images: Library,
    _cuda: Library,
    _dependencies: Vec<Library>,
    create_effect: unsafe extern "C" fn(*const c_char, *mut Handle) -> Status,
    destroy_effect: unsafe extern "C" fn(Handle),
    stream_create: unsafe extern "C" fn(*mut Handle) -> Status,
    stream_destroy: unsafe extern "C" fn(Handle) -> Status,
    stream_sync: unsafe extern "system" fn(Handle) -> Status,
    set_stream: unsafe extern "C" fn(Handle, *const c_char, Handle) -> Status,
    set_u32: unsafe extern "C" fn(Handle, *const c_char, u32) -> Status,
    set_image: unsafe extern "C" fn(Handle, *const c_char, *mut Image) -> Status,
    load_effect: unsafe extern "C" fn(Handle) -> Status,
    run_effect: unsafe extern "C" fn(Handle, i32) -> Status,
    alloc: unsafe extern "C" fn(*mut Image, u32, u32, u32, u32, u32, u32, u32) -> Status,
    dealloc: unsafe extern "C" fn(*mut Image),
    init: unsafe extern "C" fn(*mut Image, u32, u32, i32, Handle, u32, u32, u32, u32) -> Status,
    transfer: unsafe extern "C" fn(*const Image, *mut Image, f32, Handle, *mut Image) -> Status,
}

fn check(status: Status, operation: &str) -> Result<()> {
    if status == 0 {
        Ok(())
    } else {
        Err(format!("{operation} failed (SDK status {status})").into())
    }
}

impl Api {
    pub fn load() -> Result<Self> {
        let exe = std::env::current_exe()?;
        let dir = exe
            .parent()
            .ok_or("VFG host has no installation directory")?;
        let path = std::fs::read_to_string(dir.join("sdk-path.txt"))
            .map_err(|error| format!("Cannot read NVIDIA SDK location: {error}"))?;
        // The SDK's plug-in discovery rejects Windows verbatim paths.
        let root = std::path::absolute(Path::new(path.trim()))?;
        let paths = std::iter::once(root.clone()).chain(
            std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())
                .collect::<Vec<_>>(),
        );
        // NVIDIA loads the feature DLL and its CUDA dependencies by name.
        std::env::set_var("PATH", std::env::join_paths(paths)?);
        std::env::set_var("NV_VIDEO_EFFECTS_PATH", &root);
        macro_rules! symbol {
            ($lib:expr, $name:literal) => {
                *$lib.get(concat!($name, "\0").as_bytes())?
            };
        }
        // Absolute SDK paths constrain the core DLL lookup. Each function
        // pointer is kept valid by the libraries owned by this Api.
        unsafe {
            let mut dependencies = Vec::new();
            let mut dependency_files = std::fs::read_dir(&root)?
                .filter_map(|entry| entry.ok().map(|entry| entry.path()))
                .filter(|path| {
                    path.file_name()
                        .and_then(|name| name.to_str())
                        .is_some_and(|name| {
                            name.ends_with(".dll")
                                && (name.starts_with("cudart") || name.starts_with("npp"))
                        })
                })
                .collect::<Vec<_>>();
            dependency_files.sort();
            for path in dependency_files {
                dependencies.push(Library::load_with_flags(
                    path,
                    LOAD_WITH_ALTERED_SEARCH_PATH,
                )?);
            }
            let images = Library::load_with_flags(
                root.join("NVCVImage.dll"),
                LOAD_WITH_ALTERED_SEARCH_PATH,
            )?;
            let ngx = root.join("nvngxruntime.dll");
            if ngx.is_file() {
                dependencies.push(Library::load_with_flags(
                    ngx,
                    LOAD_WITH_ALTERED_SEARCH_PATH,
                )?);
            }
            let vfx = Library::load_with_flags(
                root.join("NVVideoEffects.dll"),
                LOAD_WITH_ALTERED_SEARCH_PATH,
            )?;
            let cuda = Library::load_with_flags("nvcuda.dll", LOAD_LIBRARY_SEARCH_SYSTEM32)?;
            dependencies.push(Library::load_with_flags(
                root.join("nvVFXVideoFrameGeneration.dll"),
                LOAD_WITH_ALTERED_SEARCH_PATH,
            )?);
            Ok(Self {
                create_effect: symbol!(vfx, "NvVFX_CreateEffect"),
                destroy_effect: symbol!(vfx, "NvVFX_DestroyEffect"),
                stream_create: symbol!(vfx, "NvVFX_CudaStreamCreate"),
                stream_destroy: symbol!(vfx, "NvVFX_CudaStreamDestroy"),
                stream_sync: symbol!(cuda, "cuStreamSynchronize"),
                set_stream: symbol!(vfx, "NvVFX_SetCudaStream"),
                set_u32: symbol!(vfx, "NvVFX_SetU32"),
                set_image: symbol!(vfx, "NvVFX_SetImage"),
                load_effect: symbol!(vfx, "NvVFX_Load"),
                run_effect: symbol!(vfx, "NvVFX_Run"),
                alloc: symbol!(images, "NvCVImage_Alloc"),
                dealloc: symbol!(images, "NvCVImage_Dealloc"),
                init: symbol!(images, "NvCVImage_Init"),
                transfer: symbol!(images, "NvCVImage_Transfer"),
                _vfx: vfx,
                _images: images,
                _cuda: cuda,
                _dependencies: dependencies,
            })
        }
    }

    pub fn effect(&self, width: u32, height: u32) -> Result<Effect<'_>> {
        let mut effect = Effect {
            api: self,
            handle: null_mut(),
            stream: null_mut(),
            width,
            height,
            previous: unsafe { std::mem::zeroed() },
            current: unsafe { std::mem::zeroed() },
            output: unsafe { std::mem::zeroed() },
        };
        unsafe {
            check(
                (self.stream_create)(&mut effect.stream),
                "Create CUDA stream",
            )?;
            check(
                (self.create_effect)(c"VideoFrameGeneration".as_ptr(), &mut effect.handle),
                "Create VFG effect",
            )?;
            check(
                (self.set_stream)(effect.handle, c"CudaStream".as_ptr(), effect.stream),
                "Set CUDA stream",
            )?;
            effect.set(c"InputWidth", width)?;
            effect.set(c"InputHeight", height)?;
            effect.set(c"Mode", 1)?;
            effect.set(c"AutomaticShotChangeDetectionEnabled", 1)?;
            for image in [
                &mut effect.previous,
                &mut effect.current,
                &mut effect.output,
            ] {
                check(
                    (self.alloc)(image, width, height, RGBA, U8, INTERLEAVED, GPU, 32),
                    "Allocate CUDA image",
                )?;
            }
            check((self.load_effect)(effect.handle), "Load VFG model")?;
        }
        Ok(effect)
    }
}

pub struct Effect<'a> {
    api: &'a Api,
    handle: Handle,
    stream: Handle,
    width: u32,
    height: u32,
    previous: Image,
    current: Image,
    output: Image,
}

impl Effect<'_> {
    pub fn size(&self) -> (u32, u32) {
        (self.width, self.height)
    }

    pub fn gpu_bytes(&self) -> u64 {
        self.previous.buffer_bytes + self.current.buffer_bytes + self.output.buffer_bytes
    }

    fn set(&self, name: &CStr, value: u32) -> Result<()> {
        check(
            unsafe { (self.api.set_u32)(self.handle, name.as_ptr(), value) },
            &name.to_string_lossy(),
        )
    }

    fn cpu_image(&self, pixels: NonNull<u8>) -> Result<Image> {
        let mut image = unsafe { std::mem::zeroed() };
        check(
            unsafe {
                (self.api.init)(
                    &mut image,
                    self.width,
                    self.height,
                    (self.width * 4) as i32,
                    pixels.as_ptr().cast(),
                    RGBA,
                    U8,
                    INTERLEAVED,
                    CPU,
                )
            },
            "Wrap CPU image",
        )?;
        Ok(image)
    }

    pub fn interpolate(
        &mut self,
        before: Option<&[u8]>,
        after: &[u8],
        multiplier: u32,
    ) -> Result<Vec<u8>> {
        let frame_bytes = (self.width * self.height * 4) as usize;
        if before.is_some_and(|pixels| pixels.len() != frame_bytes)
            || after.len() != frame_bytes
            || !(2..=8).contains(&multiplier)
        {
            return Err("Invalid image size or frame multiplier".into());
        }
        let mut output = vec![0; frame_bytes * (multiplier - 1) as usize];
        let previous = before
            .map(|pixels| self.cpu_image(NonNull::from(pixels).cast()))
            .transpose()?;
        let current = self.cpu_image(NonNull::from(after).cast())?;
        // The SDK reads the input buffers and writes distinct output slices.
        // Synchronize even on an SDK error before the borrowed pixels can go away.
        let result = (|| {
            unsafe {
                if let Some(previous) = &previous {
                    check(
                        (self.api.transfer)(
                            previous,
                            &mut self.previous,
                            1.0,
                            self.stream,
                            null_mut(),
                        ),
                        "Upload previous image",
                    )?;
                }
                check(
                    (self.api.transfer)(&current, &mut self.current, 1.0, self.stream, null_mut()),
                    "Upload current image",
                )?;
                check(
                    (self.api.set_image)(self.handle, c"SrcImage0".as_ptr(), &mut self.previous),
                    "Set previous image",
                )?;
                check(
                    (self.api.set_image)(self.handle, c"SrcImage1".as_ptr(), &mut self.current),
                    "Set current image",
                )?;
            }
            check(
                unsafe {
                    (self.api.set_image)(self.handle, c"DstImage0".as_ptr(), &mut self.output)
                },
                "Set output image",
            )?;
            self.set(c"FrameMultiplier", multiplier)?;
            for (index, frame) in output.chunks_exact_mut(frame_bytes).enumerate() {
                self.set(c"FrameIndex", index as u32 + 1)?;
                let mut destination = self.cpu_image(NonNull::from(frame).cast())?;
                unsafe {
                    check((self.api.run_effect)(self.handle, 0), "Generate VFG frame")?;
                    check(
                        (self.api.transfer)(
                            &self.output,
                            &mut destination,
                            1.0,
                            self.stream,
                            null_mut(),
                        ),
                        "Download VFG frame",
                    )?;
                }
            }
            Ok::<_, Box<dyn std::error::Error>>(())
        })();
        let sync = check(
            unsafe { (self.api.stream_sync)(self.stream) },
            "Synchronize CUDA stream",
        );
        result?;
        sync?;
        std::mem::swap(&mut self.previous, &mut self.current);
        Ok(output)
    }
}

impl Drop for Effect<'_> {
    fn drop(&mut self) {
        unsafe {
            if !self.handle.is_null() {
                (self.api.destroy_effect)(self.handle);
            }
            for image in [&mut self.previous, &mut self.current, &mut self.output] {
                (self.api.dealloc)(image);
            }
            if !self.stream.is_null() {
                (self.api.stream_destroy)(self.stream);
            }
        }
    }
}
