import UIKit
import Capacitor

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        window = UIWindow(windowScene: windowScene)
        window?.rootViewController = ReportBridgeViewController()
        window?.makeKeyAndVisible()

        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }
}

class ReportBridgeViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(ReportSharePlugin())
    }
}

/** Штатная панель iOS получает файл отчёта, включающий схему и тексты норм. */
@objc(ReportSharePlugin)
class ReportSharePlugin: CAPPlugin, CAPBridgedPlugin {
    let identifier = "ReportSharePlugin"
    let jsName = "ReportShare"
    let pluginMethods: [CAPPluginMethod] = [CAPPluginMethod(name: "share", returnType: CAPPluginReturnPromise)]

    @objc func share(_ call: CAPPluginCall) {
        guard let html = call.getString("html"), html.utf8.count <= 16 * 1024 * 1024 else {
            call.reject("Неверный размер отчёта")
            return
        }
        DispatchQueue.main.async {
            guard let controller = self.bridge?.viewController else {
                call.reject("Окно приложения недоступно")
                return
            }
            let file = FileManager.default.temporaryDirectory.appendingPathComponent("crashtest-\(UUID().uuidString).html")
            do {
                try html.write(to: file, atomically: true, encoding: .utf8)
                let sheet = UIActivityViewController(activityItems: [file], applicationActivities: nil)
                sheet.popoverPresentationController?.sourceView = controller.view
                sheet.popoverPresentationController?.sourceRect = CGRect(x: controller.view.bounds.midX, y: controller.view.bounds.midY, width: 1, height: 1)
                sheet.completionWithItemsHandler = { _, _, _, error in
                    try? FileManager.default.removeItem(at: file)
                    if let error = error { call.reject("Не удалось отправить отчёт", nil, error) }
                    else { call.resolve() }
                }
                controller.present(sheet, animated: true)
            } catch {
                call.reject("Не удалось сохранить отчёт", nil, error)
            }
        }
    }
}
